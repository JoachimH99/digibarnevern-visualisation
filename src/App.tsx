import { NavLink, Route, Routes } from 'react-router-dom'
import Replay from './pages/Replay'
import Eventstore from './pages/Eventstore'
import SciFiReplay from './pages/SciFiReplay'


export default function App() {
  return (
    <>
      <nav className="main-nav">
        <NavLink to="/replay">Replay</NavLink>
        <NavLink to="/eventstore">Eventstore</NavLink>
      </nav>
      <Routes>
        <Route path="/replay" element={<Replay />} />
        <Route path="/eventstore" element={<Eventstore />} />
        <Route path="/scifi" element={<SciFiReplay />} />
        <Route path="*" element={<Replay />} />
      </Routes>
    </>
  )
}
