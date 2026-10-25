import { Hero } from '@/components/babeleo/hero'
import { ListeningRoom } from '@/components/babeleo/listening-room'
import { SiteFooter } from '@/components/babeleo/site-footer'

export default function Page() {
  return (
    <>
      <Hero />
      <main id="main-content" className="room-wrap">
        <ListeningRoom />
      </main>
      <SiteFooter />
    </>
  )
}
