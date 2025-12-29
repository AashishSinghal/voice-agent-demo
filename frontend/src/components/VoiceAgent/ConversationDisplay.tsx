import { useEffect, useRef } from 'react';
import type { ConversationMessage } from '../../hooks/useSocketConnection';
import { User, Bot, AlertCircle } from 'lucide-react';
import AudioPlayer from './AudioPlayer';

interface ConversationDisplayProps {
  messages: ConversationMessage[];
}

const ConversationDisplay = ({ messages }: ConversationDisplayProps) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  });

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        No messages yet. Start recording to begin.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex gap-3 ${
            message.type === 'user' ? 'justify-end' : 'justify-start'
          }`}
        >
          {message.type === 'assistant' && (
            <div className="shrink-0 h-8 w-8 rounded-full bg-blue-500 flex items-center justify-center">
              <Bot className="h-5 w-5 text-white" />
            </div>
          )}

          <div
            className={`max-w-[80%] rounded-lg p-3 ${
              message.type === 'user'
                ? 'bg-blue-500 text-white'
                : message.type === 'system'
                ? 'bg-red-50 text-red-700 border border-red-200'
                : 'bg-gray-100 text-gray-900'
            }`}
          >
            {message.type === 'system' && (
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle className="h-4 w-4" />
                <span className="text-xs font-semibold">System</span>
              </div>
            )}
            <p className="text-sm whitespace-pre-wrap">{message.text}</p>

            {/* Audio player for assistant messages */}
            {message.type === 'assistant' && message.audioBuffer && (
              <AudioPlayer audioBuffer={message.audioBuffer} autoPlay={true} />
            )}

            <span className="text-xs opacity-70 mt-1 block">
              {message.timestamp.toLocaleTimeString()}
            </span>
          </div>

          {message.type === 'user' && (
            <div className="shrink-0 h-8 w-8 rounded-full bg-blue-500 flex items-center justify-center">
              <User className="h-5 w-5 text-white" />
            </div>
          )}
        </div>
      ))}
      <div ref={messagesEndRef} />
    </div>
  );
};

export default ConversationDisplay;
