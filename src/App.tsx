import { Navigate, Route, Routes } from 'react-router-dom'
import Replay from './pages/Replay'
export default function App() {
  return (
    <Routes>
      <Route path="/replay" element={<Replay />} />
      <Route path="*" element={<Navigate to="/replay" replace />} />
    </Routes>
  )
}
