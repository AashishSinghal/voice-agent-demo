"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/**
 * This app is dark only: every surface is zinc-950 over near-black. Following
 * the system theme drew a white card with grey text that was nearly unreadable
 * on it, so the toasts use the same palette as the side panels.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        classNames: {
          description: "!text-zinc-400",
          actionButton: "!bg-white !text-zinc-950 !font-medium",
        },
      }}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "oklch(0.141 0.005 285.823)", // zinc-950
          "--normal-text": "oklch(0.985 0 0)",
          "--normal-border": "oklch(1 0 0 / 10%)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
