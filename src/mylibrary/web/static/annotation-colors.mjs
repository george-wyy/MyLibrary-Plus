// The 8 highlight colors the backend accepts (see add_annotation's color
// check in services/library.py). `swatch` is the solid color shown in color
// pickers; `mark` is the translucent wash painted behind highlighted text.
export const ANNOTATION_COLORS = [
  { key: "yellow", swatch: "#f5cc42", mark: "#f7d96a4d" },
  { key: "red", swatch: "#e2574a", mark: "#f286794d" },
  { key: "green", swatch: "#4caf6e", mark: "#91d6a24d" },
  { key: "blue", swatch: "#3d8bd4", mark: "#84bde54d" },
  { key: "purple", swatch: "#8b6fd6", mark: "#b39ddb4d" },
  { key: "pink", swatch: "#e05a97", mark: "#ee9fba4d" },
  { key: "orange", swatch: "#df8a3d", mark: "#f7b96a4d" },
  { key: "gray", swatch: "#8a929a", mark: "#b0b8bc4d" },
];

const MARK_BY_KEY = Object.fromEntries(ANNOTATION_COLORS.map((entry) => [entry.key, entry.mark]));

export function annotationMarkColor(key) {
  return MARK_BY_KEY[key] || MARK_BY_KEY.yellow;
}
