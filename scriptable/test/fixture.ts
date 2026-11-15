import type { Domain } from "../../src/domain/index.js";

/** A typical day for the widget, relative to Sat 31 Oct 2026 14:20 in Brisbane (the test clock). */
export function seedTypicalDay(d: Domain): void {
  d.createTask({ name: "Do the line trimming", flagged: true, dueDate: "2026-10-29T09:00:00.000" });
  const chores = d.createProject({ name: "Chores", type: "sequential" });
  d.createTask({ name: "Buy fuel", projectId: chores.id });
  d.createTask({ name: "Mow the lawn", projectId: chores.id, dueDate: "2026-10-30T09:00:00.000" });
  d.createTask({ name: "Pay rent", dueDate: "2026-10-31T17:00:00.000" });
  d.createTask({ name: "Call mum", dueDate: "2026-11-01T00:00:00.000Z" }); // Sun 10:00 in Brisbane
  d.createTask({ name: "Dentist", dueDate: "2026-11-02T09:00:00.000" });
  d.createTask({ name: "Water plants", plannedDate: "2026-11-03T09:00:00.000" });
  d.createTask({ name: "Tax return", dueDate: "2026-11-20T17:00:00.000" });
}
