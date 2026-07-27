import * as React from "react";
import { cn } from "../../lib/utils";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    data-slot="textarea"
    className={cn("min-h-24 w-full resize-y rounded-md border border-input bg-input/40 px-3 py-2 font-mono text-sm leading-relaxed text-foreground shadow-sm outline-none transition-[border-color,box-shadow,background-color] placeholder:text-muted-foreground hover:border-primary/45 focus-visible:border-primary focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50", className)}
    {...props}
  />
));
Textarea.displayName = "Textarea";
