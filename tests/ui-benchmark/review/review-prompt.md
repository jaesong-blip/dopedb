# UI benchmark review prompt

Review only the supplied reference metadata/image, clean-room clone, current actual,
previous actual, diff, measurements, and IPC call log.

- Do not evaluate the reference as a pixel-copy target.
- Score only orientation, workbench hierarchy, density and alignment, action locality,
  context continuity, and accessibility.
- Every deduction must name a visible region and cite observable evidence.
- Do not treat stronger DopeDB safety or approval disclosure as a defect.
- Each finding proposes exactly one verifiable change.
- Do not infer hover, keyboard, performance, or behavior that is not supplied.
- Do not recommend copying product wording, brand assets, icons, or source code.
- Output must validate against `tests/ui-benchmark/rubric.schema.json`.
- Keep `blocking` set to `false`; a person owns baseline approval.
