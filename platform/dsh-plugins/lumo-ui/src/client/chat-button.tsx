import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentProps } from 'react'
import './chat-button.css'

/** Use the host's button tokens and states without legacy page-level overrides. */
export function ChatButton({ className = '', size = 'sm', variant = 'outline', ...props }: ComponentProps<typeof Button>) {
  return <Button {...props} size={size} variant={variant} className={`lumo-native-button ${className}`} />
}
