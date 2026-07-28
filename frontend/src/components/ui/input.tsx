import * as React from "react";
import { cn } from "../../lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ className, type, ...props }, ref) => (
  <input
    ref={ref}
    data-slot="input"
    type={type}
    className={cn("flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.035)] outline-none transition-[border-color,box-shadow,background-color] file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground hover:border-foreground/25 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted/50 disabled:opacity-50", className)}
    {...props}
  />
));
Input.displayName = "Input";
