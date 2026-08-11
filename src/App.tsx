import { Routes, Route, Navigate } from "react-router-dom";
import { SetLayout } from "./components/Layout";
import { Landing } from "./pages/Landing";
import { About } from "./pages/About";
import { Search } from "./pages/Search";
import { CreateSet } from "./pages/CreateSet";
import { SetHome } from "./pages/SetHome";
import { Tossups } from "./pages/Tossups";
import { TossupDetailPage } from "./pages/TossupDetail";
import { Bonuses } from "./pages/Bonuses";
import { BonusDetailPage } from "./pages/BonusDetail";
import { BuzzerRaces } from "./pages/BuzzerRaces";
import { FirstSentence } from "./pages/FirstSentence";
import { Packets } from "./pages/Packets";
import { Players } from "./pages/Players";
import { PlayerDetailPage } from "./pages/PlayerDetail";
import { Teams } from "./pages/Teams";
import { TeamDetailPage } from "./pages/TeamDetail";
import { CategoriesTossup } from "./pages/CategoriesTossup";
import { CategoryPlayersPage } from "./pages/CategoryPlayers";
import { CategoriesBonus } from "./pages/CategoriesBonus";
import { Tags } from "./pages/Tags";
import { Editions } from "./pages/Editions";
import { Login } from "./pages/Login";
import { Verify } from "./pages/Verify";
import { ResetPassword } from "./pages/ResetPassword";
import { Join } from "./pages/Join";
import { Admin } from "./pages/Admin";
import { Requests } from "./pages/Requests";
import { Settings } from "./pages/Settings";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/about" element={<About />} />
      <Route path="/search" element={<Search />} />
      <Route path="/login" element={<Login />} />
      <Route path="/verify" element={<Verify />} />
      <Route path="/reset" element={<ResetPassword />} />
      <Route path="/join/:slug" element={<Join />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/new" element={<CreateSet />} />
      <Route path="/set/:slug" element={<SetLayout />}>
        <Route index element={<SetHome />} />
        <Route path="tossup" element={<Tossups />} />
        <Route path="tossup/:id" element={<TossupDetailPage />} />
        <Route path="bonus" element={<Bonuses />} />
        <Route path="bonus/:id" element={<BonusDetailPage />} />
        <Route path="buzzer-races" element={<BuzzerRaces />} />
        <Route path="first-sentence" element={<FirstSentence />} />
        <Route path="packet" element={<Packets />} />
        <Route path="player" element={<Players />} />
        <Route path="player/:id" element={<PlayerDetailPage />} />
        <Route path="team" element={<Teams />} />
        <Route path="team/:id" element={<TeamDetailPage />} />
        <Route path="category/tossup" element={<CategoriesTossup />} />
        <Route path="category/tossup/:cid/players" element={<CategoryPlayersPage />} />
        <Route path="category/bonus" element={<CategoriesBonus />} />
        <Route path="tags" element={<Tags />} />
        <Route path="editions" element={<Editions />} />
        <Route path="requests" element={<Requests />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
