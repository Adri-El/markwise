-- Markwise schema v1: full product. Paste into the Supabase SQL editor.
-- Re-runnable: tables use IF NOT EXISTS; policies/triggers/indexes recreated.

---------- tables ----------
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('lecturer', 'student')),
  full_name text not null default '',
  matric_number text unique,
  created_at timestamptz not null default now(),
  check (role <> 'student' or (full_name <> '' and matric_number is not null))
);

create table if not exists assessments (
  id uuid primary key default gen_random_uuid(),
  lecturer_id uuid not null references profiles (id) on delete cascade,
  title text not null,
  kind text not null check (kind in ('assignment', 'test', 'exam')),
  instructions text not null default '',
  opens_at timestamptz,
  closes_at timestamptz,
  join_code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists questions (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references assessments (id) on delete cascade,
  code text not null,                       -- stable 'q1'.. used by the worker
  position int not null,
  prompt text not null,
  max_marks numeric not null check (max_marks > 0),
  subparts jsonb not null default '[]',     -- [{id, max_marks}]
  answer_mode text not null default 'either'
    check (answer_mode in ('typed', 'pdf', 'either')),
  unique (assessment_id, code),
  unique (assessment_id, position)
);

create table if not exists marking_schemes (   -- lecturer-only
  question_id uuid primary key references questions (id) on delete cascade,
  scheme text not null
);

create table if not exists rubrics (             -- lecturer-only
  assessment_id uuid primary key references assessments (id) on delete cascade,
  points jsonb not null default '[]',           -- worker shape + accept/reject
  reference_note text not null default '',
  approved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists enrollments (
  assessment_id uuid not null references assessments (id) on delete cascade,
  student_id uuid not null references profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (assessment_id, student_id)
);

create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references assessments (id) on delete cascade,
  student_id uuid not null references profiles (id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (assessment_id, student_id)
);

create table if not exists answers (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submissions (id) on delete cascade,
  question_id uuid not null references questions (id) on delete cascade,
  text text not null default '',
  pdf_path text,                                -- storage path or null
  updated_at timestamptz not null default now(),
  unique (submission_id, question_id)
);

create table if not exists marking_jobs (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references assessments (id) on delete cascade,
  type text not null check (type in ('build_rubric', 'mark_all')),
  status text not null default 'queued'
    check (status in ('queued', 'working', 'done', 'error')),
  progress jsonb not null default '{}',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- one live job per assessment+type (re-queue only after done/error)
create unique index if not exists marking_jobs_single_active
  on marking_jobs (assessment_id, type)
  where status in ('queued', 'working');

create table if not exists results (
  submission_id uuid primary key references submissions (id) on delete cascade,
  status text not null check (status in ('marked', 'needs_review', 'incomplete')),
  scores jsonb not null default '{}',
  awards jsonb not null default '[]',
  flags jsonb not null default '[]',
  usage jsonb not null default '{}',
  overrides jsonb not null default '{}',
  approved boolean not null default false,
  published boolean not null default false,
  marked_at timestamptz not null default now()
);

create table if not exists course_notes (   -- lecturer-only uploads
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references assessments (id) on delete cascade,
  storage_path text not null unique,
  filename text not null,
  mime_type text not null,
  size_bytes int not null check (size_bytes > 0 and size_bytes <= 20971520),
  uploaded_by uuid not null default auth.uid() references profiles,
  created_at timestamptz not null default now()
);

---------- v2: answer mode per assessment + schedule guard ----------
alter table assessments
  add column if not exists answer_mode text not null default 'typed'
  check (answer_mode in ('typed', 'pdf'));
alter table questions drop column if exists answer_mode;
alter table assessments drop constraint if exists assessments_closes_after_opens;
alter table assessments add constraint assessments_closes_after_opens
  check (closes_at is null or opens_at is null or closes_at > opens_at);

---------- helpers (after tables: language sql bodies validate at creation) ----------
-- Security-definer membership checks. Policies on assessments, enrollments and
-- profiles use these instead of querying each other's tables, or Postgres
-- raises "infinite recursion detected in policy".
create or replace function app_role() returns text
language sql stable security definer set search_path = public as
$$ select role from profiles where id = (select auth.uid()) $$;

create or replace function is_assessment_lecturer(p_assessment_id uuid)
returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
  select 1 from assessments
  where id = p_assessment_id and lecturer_id = (select auth.uid())
) $$;

create or replace function is_enrolled(p_assessment_id uuid)
returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
  select 1 from enrollments
  where assessment_id = p_assessment_id and student_id = (select auth.uid())
) $$;

create or replace function lecturer_teaches_student(p_student_id uuid)
returns boolean
language sql stable security definer set search_path = public as
$$ select exists (
  select 1 from enrollments e join assessments a on a.id = e.assessment_id
  where e.student_id = p_student_id and a.lecturer_id = (select auth.uid())
) $$;

revoke execute on function app_role() from public, anon;
revoke execute on function is_assessment_lecturer(uuid) from public, anon;
revoke execute on function is_enrolled(uuid) from public, anon;
revoke execute on function lecturer_teaches_student(uuid) from public, anon;
grant execute on function app_role() to authenticated;
grant execute on function is_assessment_lecturer(uuid) to authenticated;
grant execute on function is_enrolled(uuid) to authenticated;
grant execute on function lecturer_teaches_student(uuid) to authenticated;

---------- RLS ----------
alter table profiles enable row level security;
alter table assessments enable row level security;
alter table questions enable row level security;
alter table marking_schemes enable row level security;
alter table rubrics enable row level security;
alter table enrollments enable row level security;
alter table submissions enable row level security;
alter table answers enable row level security;
alter table marking_jobs enable row level security;
alter table results enable row level security;
alter table course_notes enable row level security;

-- profiles: own row; lecturers see enrolled students; role immutable
drop policy if exists profiles_select on profiles;
create policy profiles_select on profiles for select to authenticated using (
  id = (select auth.uid()) or lecturer_teaches_student(profiles.id));
drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own on profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()) and role = app_role());

-- assessments: lecturer owns; enrolled students read (join via RPC)
drop policy if exists assessments_lecturer on assessments;
create policy assessments_lecturer on assessments for all to authenticated
  using (lecturer_id = (select auth.uid()))
  with check (lecturer_id = (select auth.uid()) and app_role() = 'lecturer');
drop policy if exists assessments_enrolled_read on assessments;
create policy assessments_enrolled_read on assessments for select to authenticated
  using (is_enrolled(assessments.id));

-- questions: lecturer writes; lecturer + enrolled read (no scheme column here)
drop policy if exists questions_write on questions;
create policy questions_write on questions for all to authenticated
  using (exists (select 1 from assessments a
    where a.id = questions.assessment_id and a.lecturer_id = (select auth.uid())))
  with check (exists (select 1 from assessments a
    where a.id = questions.assessment_id and a.lecturer_id = (select auth.uid())));
drop policy if exists questions_enrolled_read on questions;
create policy questions_enrolled_read on questions for select to authenticated
  using (exists (
    select 1 from enrollments e join assessments a on a.id = e.assessment_id
    where e.assessment_id = questions.assessment_id
      and e.student_id = (select auth.uid())
      and (a.opens_at is null or now() >= a.opens_at)));

-- marking_schemes + rubrics: owning lecturer only
drop policy if exists schemes_lecturer on marking_schemes;
create policy schemes_lecturer on marking_schemes for all to authenticated
  using (exists (select 1 from questions q join assessments a on a.id = q.assessment_id
    where q.id = marking_schemes.question_id and a.lecturer_id = (select auth.uid())))
  with check (exists (select 1 from questions q join assessments a on a.id = q.assessment_id
    where q.id = marking_schemes.question_id and a.lecturer_id = (select auth.uid())));
drop policy if exists rubrics_lecturer on rubrics;
create policy rubrics_lecturer on rubrics for all to authenticated
  using (exists (select 1 from assessments a
    where a.id = rubrics.assessment_id and a.lecturer_id = (select auth.uid())))
  with check (exists (select 1 from assessments a
    where a.id = rubrics.assessment_id and a.lecturer_id = (select auth.uid())));

-- course_notes: owning lecturer only; students get no access
drop policy if exists course_notes_select on course_notes;
create policy course_notes_select on course_notes for select to authenticated
  using (is_assessment_lecturer(course_notes.assessment_id));
drop policy if exists course_notes_insert on course_notes;
create policy course_notes_insert on course_notes for insert to authenticated
  with check (is_assessment_lecturer(course_notes.assessment_id));
drop policy if exists course_notes_delete on course_notes;
create policy course_notes_delete on course_notes for delete to authenticated
  using (is_assessment_lecturer(course_notes.assessment_id));

-- enrollments: read own/lecturer's; leave/remove; inserts via join RPC only
drop policy if exists enrollments_read on enrollments;
create policy enrollments_read on enrollments for select to authenticated
  using (student_id = (select auth.uid())
    or is_assessment_lecturer(enrollments.assessment_id));
drop policy if exists enrollments_leave on enrollments;
create policy enrollments_leave on enrollments for delete to authenticated
  using (student_id = (select auth.uid())
    or is_assessment_lecturer(enrollments.assessment_id));

-- submissions: read own/lecturer's; student insert when enrolled;
-- no direct update: submitting goes through submit_submission()
drop policy if exists submissions_read on submissions;
create policy submissions_read on submissions for select to authenticated
  using (student_id = (select auth.uid()) or exists (
    select 1 from assessments a
    where a.id = submissions.assessment_id and a.lecturer_id = (select auth.uid())));
drop policy if exists submissions_insert_own on submissions;
create policy submissions_insert_own on submissions for insert to authenticated
  with check (student_id = (select auth.uid())
    and submissions.status = 'draft' and submissions.submitted_at is null
    and exists (
      select 1 from enrollments e where e.assessment_id = submissions.assessment_id
      and e.student_id = (select auth.uid())));

-- answers: read own/lecturer's; student writes only on a draft submission
-- while the assessment is open (null bound = no limit)
drop policy if exists answers_read on answers;
create policy answers_read on answers for select to authenticated
  using (exists (select 1 from submissions s join assessments a on a.id = s.assessment_id
    where s.id = answers.submission_id
    and (s.student_id = (select auth.uid()) or a.lecturer_id = (select auth.uid()))));
drop policy if exists answers_write_own on answers;
create policy answers_write_own on answers for all to authenticated
  using (exists (
    select 1 from submissions s join assessments a on a.id = s.assessment_id
    where s.id = answers.submission_id and s.student_id = (select auth.uid())
      and s.status = 'draft'
      and (a.opens_at is null or now() >= a.opens_at)
      and (a.closes_at is null or now() <= a.closes_at)))
  with check (exists (
    select 1 from submissions s join assessments a on a.id = s.assessment_id
    where s.id = answers.submission_id and s.student_id = (select auth.uid())
      and s.status = 'draft'
      and (a.opens_at is null or now() >= a.opens_at)
      and (a.closes_at is null or now() <= a.closes_at)));

-- answer keys are immutable (stops reparenting between submissions)
create or replace function freeze_answer_keys() returns trigger
language plpgsql as $$
begin
  if new.submission_id is distinct from old.submission_id
     or new.question_id is distinct from old.question_id then
    raise exception 'answer keys are immutable';
  end if;
  return new;
end; $$;

drop trigger if exists answers_freeze_keys on answers;
create trigger answers_freeze_keys before update on answers
for each row execute function freeze_answer_keys();

-- marking_jobs: owning lecturer manages (worker uses service key)
drop policy if exists jobs_lecturer_read on marking_jobs;
create policy jobs_lecturer_read on marking_jobs for select to authenticated
  using (exists (select 1 from assessments a
    where a.id = marking_jobs.assessment_id and a.lecturer_id = (select auth.uid())));
drop policy if exists jobs_lecturer_write on marking_jobs;
create policy jobs_lecturer_write on marking_jobs for insert to authenticated
  with check (exists (select 1 from assessments a
    where a.id = marking_jobs.assessment_id and a.lecturer_id = (select auth.uid())));
drop policy if exists jobs_lecturer_update on marking_jobs;
create policy jobs_lecturer_update on marking_jobs for update to authenticated
  using (exists (select 1 from assessments a
    where a.id = marking_jobs.assessment_id and a.lecturer_id = (select auth.uid())))
  with check (exists (select 1 from assessments a
    where a.id = marking_jobs.assessment_id and a.lecturer_id = (select auth.uid())));

-- results: lecturer manages; students read own published only (worker inserts)
drop policy if exists results_read on results;
create policy results_read on results for select to authenticated
  using (exists (select 1 from submissions s join assessments a on a.id = s.assessment_id
    where s.id = results.submission_id
    and (a.lecturer_id = (select auth.uid())
         or (s.student_id = (select auth.uid()) and results.published))));
drop policy if exists results_update_lecturer on results;
create policy results_update_lecturer on results for update to authenticated
  using (exists (select 1 from submissions s join assessments a on a.id = s.assessment_id
    where s.id = results.submission_id and a.lecturer_id = (select auth.uid())))
  with check (exists (select 1 from submissions s join assessments a on a.id = s.assessment_id
    where s.id = results.submission_id and a.lecturer_id = (select auth.uid())));

---------- grants (policies alone don't revoke defaults) ----------
revoke all on profiles, assessments, questions, marking_schemes, rubrics,
  enrollments, submissions, answers, marking_jobs, results
  from anon, authenticated;
grant select, update on profiles to authenticated;
grant select, insert, update, delete on assessments to authenticated;
grant select, insert, update, delete on questions to authenticated;
grant select, insert, update, delete on marking_schemes to authenticated;
grant select, insert, update, delete on rubrics to authenticated;
grant select, delete on enrollments to authenticated;
grant select, insert on submissions to authenticated;
grant select, insert, update, delete on answers to authenticated;
grant select, insert, update on marking_jobs to authenticated;
grant select, update on results to authenticated;
revoke all on course_notes from anon, authenticated;
grant select, insert, delete on course_notes to authenticated;

---------- profile trigger ----------
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  v_role := coalesce(new.raw_user_meta_data ->> 'role', 'student');
  if v_role not in ('lecturer', 'student') then v_role := 'student'; end if;
  insert into profiles (id, role, full_name, matric_number)
  values (new.id, v_role,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'matric_number', ''));
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function handle_new_user();

---------- join by code ----------
create or replace function join_with_code(p_code text)
returns table (assessment_id uuid, title text, kind text)
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_title text; v_kind text;
begin
  if app_role() <> 'student' then raise exception 'students only'; end if;
  select a.id, a.title, a.kind into v_id, v_title, v_kind
  from assessments a where a.join_code = upper(trim(p_code));
  if v_id is null then raise exception 'invalid code'; end if;
  insert into enrollments (assessment_id, student_id)
  values (v_id, auth.uid()) on conflict do nothing;
  insert into submissions (assessment_id, student_id)
  values (v_id, auth.uid()) on conflict do nothing;
  assessment_id := v_id; title := v_title; kind := v_kind;
  return next;
end; $$;
grant execute on function join_with_code(text) to authenticated;

---------- submit (locks the submission; answers freeze via RLS) ----------
create or replace function submit_submission(p_assessment_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_sub submissions%rowtype; v_open boolean;
begin
  select * into v_sub from submissions
  where assessment_id = p_assessment_id and student_id = auth.uid();
  if v_sub.id is null then raise exception 'no submission found'; end if;
  if v_sub.status <> 'draft' then raise exception 'already submitted'; end if;
  select (opens_at is null or now() >= opens_at)
     and (closes_at is null or now() <= closes_at)
    into v_open from assessments where id = p_assessment_id;
  if not v_open then raise exception 'assessment is closed'; end if;
  update submissions set status = 'submitted', submitted_at = now()
  where id = v_sub.id;
end; $$;
grant execute on function submit_submission(uuid) to authenticated;

---------- atomic assessment creation (one transaction, invoker RLS applies) ----------
-- p: {title, kind, instructions, opens_at, closes_at, answer_mode,
--     reference_note, questions: [{prompt, max_marks, scheme, subparts}]}
create or replace function create_assessment(p jsonb)
returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid;
  v_code text;
  v_q jsonb;
  v_idx int := 0;
  v_qid uuid;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i int;
  attempt int;
begin
  for attempt in 1..5 loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, floor(random() * 32 + 1)::int, 1);
    end loop;
    begin
      insert into assessments (lecturer_id, title, kind, instructions,
        opens_at, closes_at, answer_mode, join_code)
      values (
        (select auth.uid()),
        p->>'title', p->>'kind',
        coalesce(p->>'instructions', ''),
        nullif(p->>'opens_at', '')::timestamptz,
        nullif(p->>'closes_at', '')::timestamptz,
        coalesce(p->>'answer_mode', 'typed'),
        v_code)
      returning id into v_id;
      exit;
    exception when unique_violation then
      if attempt = 5 then raise; end if;
    end;
  end loop;

  for v_q in select * from jsonb_array_elements(p->'questions') loop
    v_idx := v_idx + 1;
    insert into questions (assessment_id, code, position, prompt, max_marks, subparts)
    values (v_id, 'q' || v_idx, v_idx, v_q->>'prompt',
      (v_q->>'max_marks')::numeric, coalesce(v_q->'subparts', '[]'))
    returning id into v_qid;
    if nullif(btrim(v_q->>'scheme'), '') is not null then
      insert into marking_schemes (question_id, scheme)
      values (v_qid, btrim(v_q->>'scheme'));
    end if;
  end loop;

  insert into rubrics (assessment_id, points, reference_note)
  values (v_id, '[]', coalesce(p->>'reference_note', ''));

  return v_id;
end; $$;

revoke execute on function create_assessment(jsonb) from public, anon;
grant execute on function create_assessment(jsonb) to authenticated;

---------- storage (private answer PDFs) ----------
insert into storage.buckets (id, name, public)
values ('answer-pdfs', 'answer-pdfs', false) on conflict (id) do nothing;
-- path convention: <assessment_id>/<student_id>/<question_id>.pdf
drop policy if exists pdf_upload_own on storage.objects;
create policy pdf_upload_own on storage.objects for insert to authenticated
  with check (bucket_id = 'answer-pdfs'
    and (storage.foldername(name))[2] = (select auth.jwt()->>'sub')
    and exists (
      select 1 from submissions s join assessments a on a.id = s.assessment_id
      where s.assessment_id::text = (storage.foldername(name))[1]
        and s.student_id = (select auth.uid())
        and s.status = 'draft'
        and (a.opens_at is null or now() >= a.opens_at)
        and (a.closes_at is null or now() <= a.closes_at)));
drop policy if exists pdf_read_own on storage.objects;
create policy pdf_read_own on storage.objects for select to authenticated
  using (bucket_id = 'answer-pdfs'
    and (storage.foldername(name))[2] = (select auth.jwt()->>'sub'));
drop policy if exists pdf_read_lecturer on storage.objects;
create policy pdf_read_lecturer on storage.objects for select to authenticated
  using (bucket_id = 'answer-pdfs' and exists (
    select 1 from assessments a
    where a.id::text = (storage.foldername(name))[1]
    and a.lecturer_id = (select auth.uid())));
drop policy if exists pdf_replace_own on storage.objects;
create policy pdf_replace_own on storage.objects for update to authenticated
  using (bucket_id = 'answer-pdfs'
    and (storage.foldername(name))[2] = (select auth.jwt()->>'sub')
    and exists (
      select 1 from submissions s join assessments a on a.id = s.assessment_id
      where s.assessment_id::text = (storage.foldername(name))[1]
        and s.student_id = (select auth.uid())
        and s.status = 'draft'
        and (a.opens_at is null or now() >= a.opens_at)
        and (a.closes_at is null or now() <= a.closes_at)))
  with check (bucket_id = 'answer-pdfs'
    and (storage.foldername(name))[2] = (select auth.jwt()->>'sub')
    and exists (
      select 1 from submissions s join assessments a on a.id = s.assessment_id
      where s.assessment_id::text = (storage.foldername(name))[1]
        and s.student_id = (select auth.uid())
        and s.status = 'draft'
        and (a.opens_at is null or now() >= a.opens_at)
        and (a.closes_at is null or now() <= a.closes_at)));
drop policy if exists pdf_delete_own on storage.objects;
create policy pdf_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'answer-pdfs'
    and (storage.foldername(name))[2] = (select auth.jwt()->>'sub')
    and exists (
      select 1 from submissions s join assessments a on a.id = s.assessment_id
      where s.assessment_id::text = (storage.foldername(name))[1]
        and s.student_id = (select auth.uid())
        and s.status = 'draft'
        and (a.opens_at is null or now() >= a.opens_at)
        and (a.closes_at is null or now() <= a.closes_at)));

---------- storage (private course notes) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('course-notes', 'course-notes', false, 20971520)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;
-- path convention: <assessment_id>/<uuid>-<sanitised filename>
drop policy if exists notes_upload_lecturer on storage.objects;
create policy notes_upload_lecturer on storage.objects for insert to authenticated
  with check (bucket_id = 'course-notes' and exists (
    select 1 from assessments a
    where a.id::text = (storage.foldername(name))[1]
    and is_assessment_lecturer(a.id)));
drop policy if exists notes_read_lecturer on storage.objects;
create policy notes_read_lecturer on storage.objects for select to authenticated
  using (bucket_id = 'course-notes' and exists (
    select 1 from assessments a
    where a.id::text = (storage.foldername(name))[1]
    and is_assessment_lecturer(a.id)));
drop policy if exists notes_delete_lecturer on storage.objects;
create policy notes_delete_lecturer on storage.objects for delete to authenticated
  using (bucket_id = 'course-notes' and exists (
    select 1 from assessments a
    where a.id::text = (storage.foldername(name))[1]
    and is_assessment_lecturer(a.id)));
