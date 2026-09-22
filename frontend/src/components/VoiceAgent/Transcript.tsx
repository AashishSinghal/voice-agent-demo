import { useEffect, useRef } from 'react';
import type { ConversationMessage } from '../../hooks/useSocketConnection';

interface TranscriptProps {
  messages: ConversationMessage[];
}

/**
 * Conversation history, deliberately understated — the orb is the focus, and
 * the transcript is there for reference and for reading back an interruption.
 */
const Transcript = ({ messages }: TranscriptProps) => {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  if (messages.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-xl space-y-3 overflow-y-auto px-6 pb-2">
      {messages.map((message) => {
        if (message.type === 'system') {
          return (
            <p key={message.id} className="text-center text-xs text-red-400/80">
              {message.text}
            </p>
          );
        }

        const isUser = message.type === 'user';
        // Over-speech is shown dimmer and labelled, so a "mhm" that did not
        // stop the agent is not mistaken for a question it ignored.
        const isAside = isUser && message.overSpeech && message.kind === 'backchannel';

        return (
          <div key={message.id} className={isUser ? 'text-right' : 'text-left'}>
            {isUser && message.overSpeech && (
              <div className="mb-0.5 text-[10px] uppercase tracking-wider text-zinc-600">
                {message.kind === 'backchannel'
                  ? 'while agent spoke · not an interruption'
                  : message.kind === 'resume'
                    ? 'while agent spoke · resume'
                    : 'interrupted the agent'}
              </div>
            )}
            <span
              className={[
                'inline-block max-w-[85%] rounded-2xl px-4 py-2 text-sm leading-relaxed',
                isUser
                  ? isAside
                    ? 'bg-white/5 text-zinc-500 italic'
                    : 'bg-white/10 text-zinc-100'
                  : 'bg-transparent text-zinc-300',
              ].join(' ')}
            >
              {message.text}
              {message.status === 'interrupted' && (
                <span
                  className="ml-1 text-amber-400/90"
                  title="The caller interrupted here — everything after this was never spoken"
                >
                  {' '}— interrupted
                </span>
              )}
            </span>
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
};

export default Transcript;
