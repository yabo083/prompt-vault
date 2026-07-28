import * as React from "react";
import { cn } from "../../lib/utils";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    data-slot="textarea"
    className={cn("min-h-24 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.035)] outline-none transition-[border-color,box-shadow,background-color] placeholder:text-muted-foreground hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted/50 disabled:opacity-50", className)}
    {...props}
  />
));
Textarea.displayName = "Textarea";
