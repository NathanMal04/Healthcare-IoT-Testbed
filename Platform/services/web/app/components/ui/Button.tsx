import { forwardRef } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./styles";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", icon: Icon, className = "", type = "button", children, ...props },
  ref
) {
  return (
    <button ref={ref} type={type} className={`${buttonClass(variant, size)} ${className}`} {...props}>
      {Icon && <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden="true" />}
      {children}
    </button>
  );
});

/** A Next.js link styled as a button. */
export function ButtonLink({
  href,
  variant = "secondary",
  size = "md",
  icon: Icon,
  className = "",
  children,
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={`${buttonClass(variant, size)} ${className}`}>
      {Icon && <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden="true" />}
      {children}
    </Link>
  );
}
