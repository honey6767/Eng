import { Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ConfirmProvider } from '@/hooks/useConfirm';
import { ToastProvider } from '@/hooks/useToast';
import { useAppInit } from '@/hooks/useAppInit';
import { Loading } from '@/components/ui/Loading';
import { DashboardPage } from '@/pages/DashboardPage';
import { VideosPage } from '@/pages/VideosPage';
import { VideoDetailPage } from '@/pages/VideoDetailPage';
import { DialoguesPage } from '@/pages/DialoguesPage';
import { DialogueDetailPage } from '@/pages/DialogueDetailPage';
import { ReviewPage } from '@/pages/ReviewPage';
import { ExpressionsPage } from '@/pages/ExpressionsPage';
import { FavoritesPage } from '@/pages/FavoritesPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { MorePage } from '@/pages/MorePage';
import { CollectionPage } from '@/pages/CollectionPage';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { AccessGate } from '@/components/access/AccessGate';

export default function App() {
  const { ready, error } = useAppInit();

  if (error) {
    return (
      <div className="mx-auto max-w-md p-6 text-center">
        <h1 className="text-lg font-bold text-danger">데이터 저장소를 열 수 없어요</h1>
        <p className="mt-2 text-sm text-muted">
          브라우저의 IndexedDB를 사용할 수 없는 환경일 수 있습니다(사생활 보호 모드 등).
        </p>
        <p className="mt-2 rounded-lg bg-surface p-2 font-mono text-xs text-muted">{error}</p>
      </div>
    );
  }
  if (!ready) return <Loading label="학습 데이터를 준비하는 중…" />;

  return (
    <ToastProvider>
      <ConfirmProvider>
        <AccessGate>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="videos" element={<VideosPage />} />
            <Route path="videos/:id" element={<VideoDetailPage />} />
            <Route path="dialogues" element={<DialoguesPage />} />
            <Route path="dialogues/:id" element={<DialogueDetailPage />} />
            <Route path="review" element={<ReviewPage />} />
            <Route path="expressions" element={<ExpressionsPage />} />
            <Route path="favorites" element={<FavoritesPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="collection" element={<CollectionPage />} />
            <Route path="more" element={<MorePage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
        </AccessGate>
      </ConfirmProvider>
    </ToastProvider>
  );
}
