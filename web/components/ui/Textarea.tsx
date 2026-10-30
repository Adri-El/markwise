import { forwardRef, type TextareaHTMLAttributes } from "react";

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

const field =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm " +
  "text-slate-900 placeholder:text-slate-400 focus:border-indigo-600 " +
  "focus:outline-none focus:ring-2 focus:ring-indigo-600/30 " +
  "disabled:bg-slate-100";

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className = "", ...rest }, ref) {
    return <textarea ref={ref} className={`${field} ${className}`} {...rest} />;
  },
);

export default Textarea;
