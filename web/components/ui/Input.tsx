import { forwardRef, type InputHTMLAttributes } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

const field =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm " +
  "text-slate-900 placeholder:text-slate-400 focus:border-indigo-600 " +
  "focus:outline-none focus:ring-2 focus:ring-indigo-600/30 " +
  "disabled:bg-slate-100";

const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className = "", ...rest },
  ref,
) {
  return <input ref={ref} className={`${field} ${className}`} {...rest} />;
});

export default Input;
