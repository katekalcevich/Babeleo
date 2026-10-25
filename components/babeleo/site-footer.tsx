const builtWith = [
  { name: 'v0', href: 'https://v0.app' },
  { name: 'OpenAI', href: 'https://openai.com' },
  { name: 'ElevenLabs', href: 'https://elevenlabs.io' },
]

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <p>
          {'© 2026 '}
          <a href="https://www.linkedin.com/in/katekalcevich/">
            Kate Kalcevich
          </a>
          . Chat with my cats.
        </p>
        <p className="site-footer-built">
          {'Built on '}
          {builtWith.map((tool, index) => (
            <span key={tool.name}>
              <a href={tool.href}>
                {tool.name}
              </a>
              {index < builtWith.length - 2 ? ', ' : index === builtWith.length - 2 ? ', and ' : '.'}
            </span>
          ))}
        </p>
      </div>
    </footer>
  )
}
