import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import {
  BUTTON_SIZE_CLASS,
  BUTTON_VARIANT_CLASS,
  type ButtonSize,
  type ButtonVariant,
} from "@/components/motion/button/base";
import { cn } from "@/lib/utils";

interface LinkButtonProps extends Omit<ComponentProps<typeof Link>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
}

/**
 * Internal navigation styled like a beUI button. Uses next/link so client-side
 * navigation preserves in-memory flow state — a plain anchor would reload the
 * document and wipe the demo store.
 */
export function LinkButton({
  variant = "primary",
  size = "md",
  className,
  children,
  ...rest
}: LinkButtonProps) {
  return (
    <Link
      className={cn(
        "inline-flex items-center justify-center font-medium select-none",
        "transition-colors",
        BUTTON_VARIANT_CLASS[variant],
        BUTTON_SIZE_CLASS[size],
        className,
      )}
      {...rest}
    >
      {children}
    </Link>
  );
}
