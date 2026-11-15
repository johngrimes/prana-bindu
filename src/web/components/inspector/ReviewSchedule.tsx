import type { Project, Settings } from "../../../shared/schemas";
import { actions, attempt } from "../../api/queries";
import { DateField, FieldRow } from "./Fields";

type Interval = Project["reviewInterval"];

/** "1 week", "2 months". */
export function formatInterval({ steps, unit }: Interval): string {
  return `${steps} ${steps === 1 ? unit : `${unit}s`}`;
}

/** Review every (interval) and Next review fields, shared by the inspector and the Review bar. */
export function ReviewSchedule({ id, project, settings }: { id: string; project: Pick<Project, "reviewInterval" | "nextReview">; settings: Settings }) {
  const patch = (p: Pick<Project, "reviewInterval"> | { nextReview: string | null }) => void attempt(actions.patchProject(id, p));
  return (
    <>
      <FieldRow label="Every">
        <div className="flex gap-2">
          <input
            type="number"
            min={1}
            className="pb-input w-20"
            aria-label="Review interval steps"
            value={project.reviewInterval.steps}
            onChange={(e) => {
              const steps = Number(e.target.value);
              if (steps >= 1) patch({ reviewInterval: { ...project.reviewInterval, steps } });
            }}
          />
          <select
            className="pb-input w-auto"
            aria-label="Review interval unit"
            value={project.reviewInterval.unit}
            onChange={(e) => patch({ reviewInterval: { ...project.reviewInterval, unit: e.target.value as Interval["unit"] } })}
          >
            {(["day", "week", "month", "year"] as const).map((u) => (
              <option key={u} value={u}>
                {project.reviewInterval.steps === 1 ? u : `${u}s`}
              </option>
            ))}
          </select>
        </div>
      </FieldRow>
      <FieldRow label="Next review">
        <DateField label="Next review" field="defer" value={project.nextReview} settings={settings} dateOnly onChange={(nextReview) => patch({ nextReview })} />
      </FieldRow>
    </>
  );
}
