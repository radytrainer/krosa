# Frontend rules

- Match the existing stack and components. Do not add a new UI library unless I approve.
- Clarity over decoration. Plain tables and forms, a calm color palette, strong contrast.
- Every screen has loading, empty, error and disabled states.
- Lists with more than 5 warnings or issues use the shared paged component (5 per page).
- Destructive or score-changing actions (sync, sheet change, removed subjects, program
  switch) need a confirmation dialog that lists exactly what will change, with counts.
- Student pages are mobile-first. Admin pages must work on a laptop.
- Show class together with term and program, for example "Term 2 · Class D · SNAC".
- Show teacher comments as plain text with line breaks kept. Never render them as HTML.
- Khmer text must display correctly: use a Khmer-capable font and avoid truncating text.
- Students never see another student's data; do not put student ids in URLs.
- Accessible by default: labels on inputs, keyboard navigation, visible focus, not color alone.
