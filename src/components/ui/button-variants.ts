import { cva } from "class-variance-authority";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium transition-[opacity,scale,background-color,color] duration-[var(--motion-quick)] ease-[var(--ease-out)] select-none disabled:pointer-events-none disabled:opacity-40 enabled:active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:opacity-90",
        ghost: "bg-transparent text-fg hover:bg-fg/8",
        quiet: "bg-elevated text-fg hover:bg-subtle",
        secondary: "bg-elevated text-fg ring-1 ring-line hover:bg-subtle",
      },
      size: {
        sm: "min-h-11 min-w-11 rounded-[var(--radius-md)] px-3 text-sm",
        md: "min-h-12 rounded-[var(--radius-md)] px-4 text-sm",
        pill: "min-h-12 rounded-full px-6 text-[15px]",
        icon: "size-11 min-h-11 min-w-11 rounded-full p-0",
      },
    },
    defaultVariants: { variant: "ghost", size: "sm" },
  },
);
