-- Security patch for an already-provisioned database (0001/0002 already applied).
-- Apply via: Supabase Dashboard → SQL Editor → paste → Run.
--
-- Safe to re-run: every statement here is either `create or replace function`
-- or an idempotent `revoke`/`grant`. It does not touch table definitions, so
-- it can be applied without redoing 0001_init.sql.
--
-- Fixes:
--   1. NULL-safe organizer checks in manage_membership / list_memberships.
--      `role_in()` returns NULL for non-members, and `NULL != 'organizer'`
--      evaluates to NULL (not TRUE) in SQL — so the old `!=` check silently
--      let non-members through instead of raising. Combined with (2) below,
--      this was an unauthenticated privilege-escalation / email-enumeration
--      path. Now uses `is distinct from`, which is NULL-safe.
--   2. Explicit revoke/grant on get_plan, replace_plan, manage_membership,
--      list_memberships so they are only callable by `authenticated`, not
--      the default `anon`/`public` grant Postgres gives new functions.
--   3. Row-count / byte-size guards in replace_plan against oversized
--      payloads (defense-in-depth; there was no limit before).
--   4. get_plan redacts people.notes to organizers only (may hold private
--      remarks about a volunteer). Note this covers only this RPC's read
--      path — the people_read RLS policy and the realtime publication still
--      expose the raw row to any member; see the comment inline.

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
          -- Organizer-only: notes may hold private remarks about a volunteer.
          -- Note this covers only the get_plan read path — the people_read RLS
          -- policy and the realtime publication still expose the raw row
          -- (incl. notes) to any member. Closing that fully needs notes moved
          -- to a separate organizer-only table excluded from the publication.
          'notes', case when v_role = 'organizer' then p.notes else null end
        ) order by p.name)
        from people p where p.plan_id = v_plan_id
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
  if v_role is null or v_role != 'organizer' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  v_state := payload -> 'state';
  if v_state is null then
    raise exception 'payload.state is required';
  end if;

  -- Defence-in-depth against oversized payloads: replace_plan is a single big
  -- write with no per-row size limit to lean on otherwise. Limits are generous
  -- for a real conference plan but bound the worst case.
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

  -- Bump revision first so subscribers see it before the row storm.
  update plans set
    revision = revision + 1,
    event_name = coalesce(v_state ->> 'eventName', event_name),
    rules = coalesce(v_state -> 'rules', rules)
  where id = p_plan_id
  returning revision into v_new_rev;

  if v_new_rev is null then
    raise exception 'plan not found' using errcode = 'P0002';
  end if;

  -- Upsert days, prune removed
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

  -- Upsert people, prune removed
  delete from people where plan_id = p_plan_id
    and id not in (select p ->> 'id' from jsonb_array_elements(v_state -> 'people') as p);

  for v_person in select * from jsonb_array_elements(v_state -> 'people')
  loop
    insert into people (plan_id, id, name, is_organizer, available_day_ids, multi_shift, max_shifts, tags, notes)
    values (
      p_plan_id,
      v_person ->> 'id',
      v_person ->> 'name',
      coalesce((v_person ->> 'isOrganizer')::boolean, false),
      coalesce((select array_agg(x::text) from jsonb_array_elements_text(v_person -> 'availableDayIds') as x), '{}'),
      coalesce((v_person ->> 'multiShift')::boolean, false),
      (v_person ->> 'maxShifts')::int,
      coalesce((select array_agg(x::text) from jsonb_array_elements_text(v_person -> 'tags') as x), '{}'),
      v_person ->> 'notes'
    )
    on conflict (plan_id, id) do update set
      name = excluded.name,
      is_organizer = excluded.is_organizer,
      available_day_ids = excluded.available_day_ids,
      multi_shift = excluded.multi_shift,
      max_shifts = excluded.max_shifts,
      tags = excluded.tags,
      notes = excluded.notes
    where (people.name, people.is_organizer, people.available_day_ids, people.multi_shift, people.max_shifts, people.tags, people.notes)
      is distinct from (excluded.name, excluded.is_organizer, excluded.available_day_ids, excluded.multi_shift, excluded.max_shifts, excluded.tags, excluded.notes);
  end loop;

  -- Upsert tasks, prune removed
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

  -- Upsert assignments, prune removed
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

-- ---------------------------------------------------------------- manage_membership

create or replace function manage_membership(
  p_plan_id uuid,
  p_action text,        -- 'add', 'update', 'remove'
  p_email citext,
  p_role text default null,
  p_person_id text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_caller_role text;
  v_org_count int;
begin
  v_caller_role := role_in(p_plan_id);
  -- NULL-safe: role_in() returns NULL for non-members, and `NULL != 'organizer'`
  -- is NULL (not TRUE) in SQL, so a plain != here would silently let non-members
  -- through — this is what made anonymous privilege escalation possible.
  if v_caller_role is distinct from 'organizer' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  if p_action = 'add' then
    insert into memberships (plan_id, email, role, person_id)
    values (p_plan_id, p_email, coalesce(p_role, 'volunteer'), p_person_id)
    on conflict (plan_id, email) do update set
      role = coalesce(p_role, memberships.role),
      person_id = coalesce(p_person_id, memberships.person_id);
    return jsonb_build_object('ok', true);

  elsif p_action = 'update' then
    update memberships set
      role = coalesce(p_role, role),
      person_id = coalesce(p_person_id, person_id)
    where plan_id = p_plan_id and email = p_email;
    return jsonb_build_object('ok', true);

  elsif p_action = 'remove' then
    -- Prevent removing the last organizer
    select count(*) into v_org_count
      from memberships
     where plan_id = p_plan_id and role = 'organizer' and email != p_email;
    if v_org_count = 0 then
      raise exception 'cannot remove the last organizer' using errcode = 'P0001';
    end if;
    delete from memberships where plan_id = p_plan_id and email = p_email;
    return jsonb_build_object('ok', true);

  else
    raise exception 'unknown action: %', p_action;
  end if;
end;
$$;

revoke execute on function manage_membership(uuid, text, citext, text, text) from public, anon;
grant  execute on function manage_membership(uuid, text, citext, text, text) to authenticated;

-- ---------------------------------------------------------------- list_memberships

create or replace function list_memberships(p_plan_id uuid)
returns table (email citext, role text, person_id text)
language plpgsql stable security definer set search_path = public as $$
begin
  -- Only organizers may see the full list. NULL-safe: role_in() returns NULL
  -- for non-members, and `NULL != 'organizer'` is NULL (not TRUE) in SQL, so a
  -- plain != here would silently let non-members through.
  if role_in(p_plan_id) is distinct from 'organizer' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  return query
    select m.email, m.role, m.person_id
      from memberships m
     where m.plan_id = p_plan_id
     order by m.role, m.email;
end;
$$;

revoke execute on function list_memberships(uuid) from public, anon;
grant  execute on function list_memberships(uuid) to authenticated;
