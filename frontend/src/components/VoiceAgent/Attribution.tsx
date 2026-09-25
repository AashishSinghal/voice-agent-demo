import { Github, Globe, Linkedin } from 'lucide-react';

const LINKS = [
  { href: 'https://github.com/AashishSinghal', label: 'GitHub', Icon: Github },
  { href: 'https://www.linkedin.com/in/iamaashish5', label: 'LinkedIn', Icon: Linkedin },
  { href: 'https://aashishsinghal.com', label: 'Portfolio', Icon: Globe },
];

/**
 * Credit line.
 *
 * Deliberately quiet: the orb is the only thing that should draw the eye
 * during a call, so this sits below the control, muted, and lifts to full
 * contrast only on hover.
 */
const Attribution = () => (
  <div className="flex items-center gap-3 text-xs text-zinc-600">
    <span>
      Built by{' '}
      <a
        href="https://aashishsinghal.com"
        target="_blank"
        rel="noreferrer"
        className="text-zinc-500 underline-offset-4 transition hover:text-zinc-300 hover:underline"
      >
        Aashish Singhal
      </a>
    </span>

    <span aria-hidden className="h-3 w-px bg-white/10" />

    <div className="flex items-center gap-1">
      {LINKS.map(({ href, label, Icon }) => (
        <a
          key={label}
          href={href}
          target="_blank"
          rel="noreferrer"
          aria-label={label}
          title={label}
          className="rounded p-1.5 text-zinc-600 transition hover:bg-white/5 hover:text-zinc-200"
        >
          <Icon className="h-3.5 w-3.5" />
        </a>
      ))}
    </div>
  </div>
);

export default Attribution;
