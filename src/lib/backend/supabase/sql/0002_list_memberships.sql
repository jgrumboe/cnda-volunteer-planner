-- Organizer-only: list all memberships for a plan.
-- Required because the self-read RLS policy only returns your own row.
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
