-- Move people.notes into an organizer-only table.
-- Apply via: Supabase Dashboard → SQL Editor → paste → Run.
-- Safe to re-run: idempotent guards on every statement.
--
-- WHY
-- ---
-- `people.notes` holds private organizer remarks about a volunteer. Before this
-- migration the only thing protecting it was the `case when v_role = 'organizer'`
-- redaction inside get_plan — which was cosmetic, because two other paths served
-- the raw column to ANY member of the plan:
--
--   1. The `people_read` RLS policy grants `select` to every member, so a
--      volunteer could simply call `from('people').select('notes')`.
--   2. `people` is in the `supabase_realtime` publication, so every UPDATE
--      pushed the raw row (including notes) to every subscribed volunteer.
--
-- RLS is row-level, not column-level, so the column cannot be hidden from
-- volunteers while `people` stays readable by them. The fix is to relocate the
-- column to its own table whose RLS is organizer-only and which is deliberately
-- NOT in the realtime publication (same reasoning as `memberships`).
--
-- After this, the redaction is enforced by the database on every read path
-- rather than by one CASE expression in one RPC.

-- ---------------------------------------------------------------- table

create table if not exists person_notes (
  plan_id uuid not null references plans(id) on delete cascade,
  person_id text not null,
  notes text,
  updated_at timestamptz not null default now(),
  primary key (plan_id, person_id),
  foreign key (plan_id, person_id) references people(plan_id, id) on delete cascade
);

drop trigger if exists person_notes_updated_at on person_notes;
create trigger person_notes_updated_at before update on person_notes
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- backfill

-- Copy existing notes across before the column is dropped.
insert into person_notes (plan_id, person_id, notes)
select p.plan_id, p.id, p.notes
  from people p
 where p.notes is not null
   and p.notes <> ''
on conflict (plan_id, person_id) do nothing;

alter table people drop column if exists notes;

-- ---------------------------------------------------------------- RLS

alter table person_notes enable row level security;

-- Organizer-only for BOTH read and write. Volunteers get no policy at all,
-- so RLS denies them by default.
drop policy if exists person_notes_read  on person_notes;
drop policy if exists person_notes_write on person_notes;

create policy person_notes_read on person_notes for select to authenticated
  using (role_in(plan_id) = 'organizer');
create policy person_notes_write on person_notes for all to authenticated
  using (role_in(plan_id) = 'organizer') with check (role_in(plan_id) = 'organizer');

-- person_notes is deliberately NOT added to the supabase_realtime publication.
-- DELETE payloads bypass RLS on old_record, and there is no reason to stream
-- private remarks to subscribers. Organizers pick notes up via get_plan.

-- ---------------------------------------------------------------- get_plan

create or replace function get_plan(p_slug text)
returns jsonb
language plpgsql stable security invoker as $$
declare
  v_plan_id uuid;
  v_revision bigint;
  v_event_name text;
  v_rules jsonb;
  v_role text;
  v_person_id text;
begin
  select id, revision, event_name, rules
    into v_plan_id, v_revision, v_event_name, v_rules
    from plans where slug = p_slug;

  if v_plan_id is null then
    return null;
  end if;

  v_role := role_in(v_plan_id);
  if v_role is null then
    return jsonb_build_object('error', 'not_a_member');
  end if;

  select person_id into v_person_id
    from memberships
   where plan_id = v_plan_id
     and email = (auth.jwt() ->> 'email')::citext;

  return jsonb_build_object(
    'planId', v_plan_id,
    'revision', v_revision,
    'role', v_role,
    'personId', v_person_id,
    'state', jsonb_build_object(
      'version', 1,
      'eventName', v_event_name,
      'days', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', d.id, 'label', d.label, 'date', d.date::text,
          'offeredToVolunteers', d.offered_to_volunteers
        ) order by d.sort_order, d.date)
        from days d where d.plan_id = v_plan_id
      ), '[]'::jsonb),
      'people', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', p.id, 'name', p.name, 'isOrganizer', p.is_organizer,
          'availableDayIds', p.available_day_ids,
          'multiShift', p.multi_shift, 'maxShifts', p.max_shifts,
          'tags', p.tags,
          -- Organizer-only. The `case` is now belt-and-braces: person_notes RLS
          -- is organizer-only and this function is `security invoker`, so the
          -- join yields NULL for a volunteer even without the guard. Unlike
          -- before, there is no other read path that bypasses this.
          'notes', case when v_role = 'organizer' then pn.notes else null end
        ) order by p.name)
        from people p
        left join person_notes pn
          on pn.plan_id = p.plan_id and pn.person_id = p.id
        where p.plan_id = v_plan_id
      ), '[]'::jsonb),
      'tasks', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', t.id, 'dayId', t.day_id, 'start', t.start_min, 'end', t.end_min,
          'title', t.title, 'category', t.category,
          'needed', t.needed, 'notes', t.notes
        ) order by t.day_id, t.start_min)
        from tasks t where t.plan_id = v_plan_id
      ), '[]'::jsonb),
      'assignments', coalesce((
        select jsonb_agg(jsonb_build_object(
          'taskId', a.task_id, 'personId', a.person_id,
          'pinned', a.pinned, 'source', a.source
        ))
        from assignments a where a.plan_id = v_plan_id
      ), '[]'::jsonb),
      'rules', v_rules
    ),
    'clocks', jsonb_build_object(
      'days', coalesce((select jsonb_object_agg(d.id, d.updated_at) from days d where d.plan_id = v_plan_id), '{}'::jsonb),
      'people', coalesce((select jsonb_object_agg(p.id, p.updated_at) from people p where p.plan_id = v_plan_id), '{}'::jsonb),
      'tasks', coalesce((select jsonb_object_agg(t.id, t.updated_at) from tasks t where t.plan_id = v_plan_id), '{}'::jsonb),
      'assignments', coalesce((select jsonb_object_agg(a.task_id || '::' || a.person_id, a.updated_at) from assignments a where a.plan_id = v_plan_id), '{}'::jsonb)
    )
  );
end;
$$;

revoke execute on function get_plan(text) from public, anon;
grant  execute on function get_plan(text) to authenticated;

-- ---------------------------------------------------------------- replace_plan

create or replace function replace_plan(p_plan_id uuid, payload jsonb)
returns bigint
language plpgsql security invoker as $$
declare
  v_role text;
  v_new_rev bigint;
  v_state jsonb;
  v_day jsonb;
  v_person jsonb;
  v_task jsonb;
  v_assignment jsonb;
begin
  v_role := role_in(p_plan_id);
  if v_role is distinct from 'organizer' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  v_state := payload -> 'state';
  if v_state is null then
    raise exception 'payload.state is required';
  end if;

  if pg_column_size(payload) > 10 * 1024 * 1024 then
    raise exception 'payload too large (max 10MB)' using errcode = '22001';
  end if;
  if jsonb_array_length(coalesce(v_state -> 'days', '[]'::jsonb)) > 60
     or jsonb_array_length(coalesce(v_state -> 'people', '[]'::jsonb)) > 2000
     or jsonb_array_length(coalesce(v_state -> 'tasks', '[]'::jsonb)) > 5000
     or jsonb_array_length(coalesce(v_state -> 'assignments', '[]'::jsonb)) > 20000
  then
    raise exception 'payload exceeds row-count limits' using errcode = '22001';
  end if;

  update plans set
    revision = revision + 1,
    event_name = coalesce(v_state ->> 'eventName', event_name),
    rules = coalesce(v_state -> 'rules', rules)
  where id = p_plan_id
  returning revision into v_new_rev;

  if v_new_rev is null then
    raise exception 'plan not found' using errcode = 'P0002';
  end if;

  delete from days where plan_id = p_plan_id
    and id not in (select d ->> 'id' from jsonb_array_elements(v_state -> 'days') as d);

  for v_day in select * from jsonb_array_elements(v_state -> 'days')
  loop
    insert into days (plan_id, id, label, date, offered_to_volunteers, sort_order)
    values (
      p_plan_id,
      v_day ->> 'id',
      v_day ->> 'label',
      (v_day ->> 'date')::date,
      coalesce((v_day ->> 'offeredToVolunteers')::boolean, true),
      coalesce((v_day ->> 'sortOrder')::int, 0)
    )
    on conflict (plan_id, id) do update set
      label = excluded.label,
      date = excluded.date,
      offered_to_volunteers = excluded.offered_to_volunteers,
      sort_order = excluded.sort_order
    where (days.label, days.date, days.offered_to_volunteers, days.sort_order)
      is distinct from (excluded.label, excluded.date, excluded.offered_to_volunteers, excluded.sort_order);
  end loop;

  delete from people where plan_id = p_plan_id
    and id not in (select p ->> 'id' from jsonb_array_elements(v_state -> 'people') as p);

  -- `notes` is no longer a column on people; it round-trips via person_notes below.
  for v_person in select * from jsonb_array_elements(v_state -> 'people')
  loop
    insert into people (plan_id, id, name, is_organizer, available_day_ids, multi_shift, max_shifts, tags)
    values (
      p_plan_id,
      v_person ->> 'id',
      v_person ->> 'name',
      coalesce((v_person ->> 'isOrganizer')::boolean, false),
      coalesce((select array_agg(x::text) from jsonb_array_elements_text(v_person -> 'availableDayIds') as x), '{}'),
      coalesce((v_person ->> 'multiShift')::boolean, false),
      (v_person ->> 'maxShifts')::int,
      coalesce((select array_agg(x::text) from jsonb_array_elements_text(v_person -> 'tags') as x), '{}')
    )
    on conflict (plan_id, id) do update set
      name = excluded.name,
      is_organizer = excluded.is_organizer,
      available_day_ids = excluded.available_day_ids,
      multi_shift = excluded.multi_shift,
      max_shifts = excluded.max_shifts,
      tags = excluded.tags
    where (people.name, people.is_organizer, people.available_day_ids, people.multi_shift, people.max_shifts, people.tags)
      is distinct from (excluded.name, excluded.is_organizer, excluded.available_day_ids, excluded.multi_shift, excluded.max_shifts, excluded.tags);
  end loop;

  -- person_notes: only touch rows the payload actually carries a `notes` key for.
  -- A payload from a volunteer-visible export has no notes at all, so a blanket
  -- delete here would silently destroy every organizer note on import.
  for v_person in
    select * from jsonb_array_elements(v_state -> 'people')
     where value ? 'notes'
  loop
    if coalesce(v_person ->> 'notes', '') = '' then
      delete from person_notes
       where plan_id = p_plan_id and person_id = v_person ->> 'id';
    else
      insert into person_notes (plan_id, person_id, notes)
      values (p_plan_id, v_person ->> 'id', v_person ->> 'notes')
      on conflict (plan_id, person_id) do update set notes = excluded.notes
      where person_notes.notes is distinct from excluded.notes;
    end if;
  end loop;

  delete from tasks where plan_id = p_plan_id
    and id not in (select t ->> 'id' from jsonb_array_elements(v_state -> 'tasks') as t);

  for v_task in select * from jsonb_array_elements(v_state -> 'tasks')
  loop
    insert into tasks (plan_id, id, day_id, start_min, end_min, title, category, needed, notes)
    values (
      p_plan_id,
      v_task ->> 'id',
      v_task ->> 'dayId',
      (v_task ->> 'start')::int,
      (v_task ->> 'end')::int,
      v_task ->> 'title',
      v_task ->> 'category',
      coalesce((v_task ->> 'needed')::int, 1),
      v_task ->> 'notes'
    )
    on conflict (plan_id, id) do update set
      day_id = excluded.day_id,
      start_min = excluded.start_min,
      end_min = excluded.end_min,
      title = excluded.title,
      category = excluded.category,
      needed = excluded.needed,
      notes = excluded.notes
    where (tasks.day_id, tasks.start_min, tasks.end_min, tasks.title, tasks.category, tasks.needed, tasks.notes)
      is distinct from (excluded.day_id, excluded.start_min, excluded.end_min, excluded.title, excluded.category, excluded.needed, excluded.notes);
  end loop;

  delete from assignments where plan_id = p_plan_id
    and (task_id, person_id) not in (
      select a ->> 'taskId', a ->> 'personId'
      from jsonb_array_elements(v_state -> 'assignments') as a
    );

  for v_assignment in select * from jsonb_array_elements(v_state -> 'assignments')
  loop
    insert into assignments (plan_id, task_id, person_id, pinned, source)
    values (
      p_plan_id,
      v_assignment ->> 'taskId',
      v_assignment ->> 'personId',
      coalesce((v_assignment ->> 'pinned')::boolean, true),
      coalesce(v_assignment ->> 'source', 'manual')
    )
    on conflict (plan_id, task_id, person_id) do update set
      pinned = excluded.pinned,
      source = excluded.source
    where (assignments.pinned, assignments.source)
      is distinct from (excluded.pinned, excluded.source);
  end loop;

  return v_new_rev;
end;
$$;

revoke execute on function replace_plan(uuid, jsonb) from public, anon;
grant  execute on function replace_plan(uuid, jsonb) to authenticated;
