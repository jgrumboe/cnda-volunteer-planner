-- CND Austria Volunteer Planner — Supabase schema
-- Apply via: Supabase Dashboard → SQL Editor → paste → Run
-- Then insert a plans row and your organizer membership manually.

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------------------------------------------------------------- tables

create table plans (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  event_name text not null default 'Cloud Native Days Austria',
  rules jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

-- The ONLY place an email exists. Deliberately NOT in the realtime publication.
create table memberships (
  plan_id uuid not null references plans(id) on delete cascade,
  email citext not null,
  role text not null check (role in ('organizer','volunteer')),
  person_id text,
  invited_at timestamptz not null default now(),
  primary key (plan_id, email)
);

create table days (
  plan_id uuid not null references plans(id) on delete cascade,
  id text not null,
  label text not null,
  date date not null,
  offered_to_volunteers boolean not null default true,
  sort_order int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (plan_id, id)
);

create table people (
  plan_id uuid not null references plans(id) on delete cascade,
  id text not null,
  name text not null default '',
  is_organizer boolean not null default false,
  available_day_ids text[] not null default '{}',
  multi_shift boolean not null default false,
  max_shifts int,
  tags text[] not null default '{}',
  notes text,
  updated_at timestamptz not null default now(),
  primary key (plan_id, id)
);

create table tasks (
  plan_id uuid not null references plans(id) on delete cascade,
  id text not null,
  day_id text not null,
  start_min int not null check (start_min between 0 and 1440),
  end_min   int not null check (end_min   between 0 and 1440),
  title text not null default '',
  category text not null,
  needed int not null default 1 check (needed >= 0),
  notes text,
  updated_at timestamptz not null default now(),
  primary key (plan_id, id)
);

create table assignments (
  plan_id uuid not null references plans(id) on delete cascade,
  task_id text not null,
  person_id text not null,
  pinned boolean not null default true,
  source text not null default 'manual' check (source in ('manual','suggested','imported')),
  updated_at timestamptz not null default now(),
  primary key (plan_id, task_id, person_id),
  foreign key (plan_id, task_id)   references tasks(plan_id, id)  on delete cascade,
  foreign key (plan_id, person_id) references people(plan_id, id) on delete cascade
);

-- ---------------------------------------------------------------- updated_at trigger

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger plans_updated_at       before update on plans       for each row execute function touch_updated_at();
create trigger days_updated_at        before update on days        for each row execute function touch_updated_at();
create trigger people_updated_at      before update on people      for each row execute function touch_updated_at();
create trigger tasks_updated_at       before update on tasks       for each row execute function touch_updated_at();
create trigger assignments_updated_at before update on assignments for each row execute function touch_updated_at();

-- ---------------------------------------------------------------- RLS helper

create or replace function role_in(p_plan_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select m.role from memberships m
   where m.plan_id = p_plan_id
     and m.email = (auth.jwt() ->> 'email')::citext
   limit 1
$$;

revoke execute on function role_in(uuid) from public, anon;
grant  execute on function role_in(uuid) to authenticated;

-- ---------------------------------------------------------------- RLS policies

alter table plans enable row level security;
alter table memberships enable row level security;
alter table days enable row level security;
alter table people enable row level security;
alter table tasks enable row level security;
alter table assignments enable row level security;

-- plans: readable by members, writable by organizers
create policy plans_read  on plans for select to authenticated
  using (role_in(id) is not null);
create policy plans_write on plans for all to authenticated
  using (role_in(id) = 'organizer') with check (role_in(id) = 'organizer');

-- memberships: self-read only (so the client learns its role and person_id)
create policy memberships_self on memberships for select to authenticated
  using (email = (auth.jwt() ->> 'email')::citext);

-- days
create policy days_read  on days for select to authenticated
  using (role_in(plan_id) is not null);
create policy days_write on days for all to authenticated
  using (role_in(plan_id) = 'organizer') with check (role_in(plan_id) = 'organizer');

-- people
create policy people_read  on people for select to authenticated
  using (role_in(plan_id) is not null);
create policy people_write on people for all to authenticated
  using (role_in(plan_id) = 'organizer') with check (role_in(plan_id) = 'organizer');

-- tasks
create policy tasks_read  on tasks for select to authenticated
  using (role_in(plan_id) is not null);
create policy tasks_write on tasks for all to authenticated
  using (role_in(plan_id) = 'organizer') with check (role_in(plan_id) = 'organizer');

-- assignments
create policy assignments_read  on assignments for select to authenticated
  using (role_in(plan_id) is not null);
create policy assignments_write on assignments for all to authenticated
  using (role_in(plan_id) = 'organizer') with check (role_in(plan_id) = 'organizer');

-- ---------------------------------------------------------------- realtime publication

-- memberships deliberately excluded: it holds email addresses and
-- DELETE payloads bypass RLS on the old_record.
alter publication supabase_realtime add table plans, days, people, tasks, assignments;

-- ---------------------------------------------------------------- RPCs

-- get_plan: single consistent read of the full plan state
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
          'tags', p.tags, 'notes', p.notes
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

-- replace_plan: atomic full-plan replacement (import, reset)
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

-- ---------------------------------------------------------------- membership management RPC

-- Organizer-only: manage memberships without exposing the table to broad policies.
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
  if v_caller_role != 'organizer' then
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
