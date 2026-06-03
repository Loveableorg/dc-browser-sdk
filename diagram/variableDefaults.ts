// Shared port of src/lib/variableDefaults.ts so edge runtimes derive
// the same defaults as the UI when materializing variable values.
//
// Object/array variables typically declare per-field defaults rather than
// a top-level defaultValue; without recursion templates like
// `<%= it.project.title %>` silently NPE on import. Mirror UI semantics
// exactly.

type Def = {
  type?: string;
  defaultValue?: unknown;
  fields?: Def[];
  itemSchema?: unknown;
  name?: string;
};

export function deriveEffectiveDefault(def: Def | undefined): unknown {
  if (!def) return undefined;
  if (def.defaultValue !== undefined) return def.defaultValue;
  if (def.type === "function") return undefined;
  if (def.type === "object") {
    const out: Record<string, unknown> = {};
    if (Array.isArray(def.fields)) {
      for (const field of def.fields) {
        const fv = deriveEffectiveDefault(field as Def);
        if (fv !== undefined && field.name) out[field.name] = fv;
      }
    }
    return out;
  }
  if (def.type === "array" || def.itemSchema) return [];
  return undefined;
}
