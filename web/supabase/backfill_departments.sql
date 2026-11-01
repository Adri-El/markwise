-- Run once in the Supabase SQL editor after schema.sql.
update assessments
set departments = array['Computer Science', 'Mathematics']
where id = '66ba23c7-5020-4ec3-b5bb-bda93ae9f88a';

update submissions
set department = 'Computer Science'
where id = 'dc7ba0ef-fc5c-435e-810e-9f18bf192a78';

update submissions
set department = 'Mathematics'
where id = '48ca7b8e-79ca-46bb-b09e-d00602031a4c';

update profiles
set full_name = 'Chinomso Amadi', matric_number = '2023/197331'
where id = (
  select student_id from submissions
  where id = '48ca7b8e-79ca-46bb-b09e-d00602031a4c'
);
