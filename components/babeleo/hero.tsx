import Image from 'next/image'
import { CATS, type CatId } from '@/lib/cats'

function CatColumn({ id }: { id: CatId }) {
  const cat = CATS[id]
  return (
    <div className={`cat-col cat-col--${id}`}>
      <div className="cat-portrait">
        <Image src={cat.header} alt={cat.alt} fill priority sizes="(max-width: 700px) 45vw, 400px" />
      </div>
      <h2 className="cat-name">{cat.name}</h2>
      <p className="cat-bio">{cat.bio}</p>
    </div>
  )
}

export function Hero() {
  return (
    <header className="hero">
      <div className="hero-inner">
        <Image src="/images/logo.png" alt="Babeleo" width={72} height={72} className="hero-logo" priority />
        <h1 className="hero-title text-balance">Two cats. No consensus.</h1>
        <div className="hero-cats">
          <CatColumn id="babe" />
          <CatColumn id="leo" />
        </div>
      </div>
    </header>
  )
}
