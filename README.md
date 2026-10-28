# Markwise

AI marking assistant for lecturers. Lecturers set assignments, tests and exams;
students submit typed answers or PDFs; the marking agent marks every script
against the lecturer's marking scheme, backs every mark with a quote from the
answer, flags what it can't judge, and the lecturer reviews and exports results
to Excel.

Built for the Meta Global AI Developer Hackathon (startup track) with Muse Code.

## Layout

- `web/`: Next.js app for lecturers and students
- `worker/`: Python marking agent
- `evals/`: accuracy tests against human marks
- `data/sample/`: sample assessments and answers (no real student data)
