import { Navigate, Route, Routes } from 'react-router-dom'
import Replay from './pages/Replay'
import Eventstore from './pages/Eventstore'
export default function App() {
  return (
    <Routes>
      <Route path="/replay" element={<Replay />} />
      <Route path="/eventstore" element={<Eventstore />} />
      <Route path="*" element={<Navigate to="/replay" replace />} />
    </Routes>
  )
}
