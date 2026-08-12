import type { HTMLAttributes, LabelHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function FieldGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn("flex flex-col gap-4", className)} {...props} />; }
export function Field({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn("flex flex-col gap-2", className)} {...props} />; }
export function FieldLabel({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) { return <label className={cn("text-sm font-medium leading-none", className)} {...props} />; }
export function FieldDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) { return <p className={cn("text-sm text-muted-foreground", className)} {...props} />; }
