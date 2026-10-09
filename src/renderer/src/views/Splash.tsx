import { Logo } from '../components'

export function Splash() {
  return (
    <div className="splash">
      <div className="splash-inner">
        <Logo size={88} />
        <h1 className="splash-name">Recall</h1>
        <div className="loader" role="progressbar" aria-label="Starting Recall" />
      </div>
    </div>
  )
}
