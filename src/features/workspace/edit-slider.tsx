/** One slider row for every tool: label, live value with its unit, then the range. */
export function EditSlider({
  label,
  value,
  min = 0,
  max = 100,
  unit,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  /** Shown after the value and read out with it, e.g. "px", "%", "°". */
  readonly unit?: string;
  readonly onChange: (value: number) => void;
}) {
  const text = unit ? `${value}${unit === "%" || unit === "°" ? "" : " "}${unit}` : String(value);
  return (
    <label className="edit-slider">
      <span>
        {label}
        <output>{text}</output>
      </span>
      <input
        aria-label={label}
        aria-valuetext={text}
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
