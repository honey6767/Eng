import { integrationConfig } from './config';
import type { ProxyStatus } from './youtubeClient';

export type IntegrationState =
  /** 연동 코드와 서버 설정이 모두 준비되어 실제로 작동 */
  | 'connected'
  /** 연동 코드가 아직 구현되지 않음 (해당 개발 단계 예정) */
  | 'not_implemented'
  /** 코드는 있으나 서버 주소/키가 설정되지 않음 */
  | 'not_configured'
  /** 외부 서비스 정책상 일부만 가능 (대안 제공) */
  | 'limited';

export interface IntegrationInfo {
  id: 'youtube' | 'transcript' | 'ai' | 'supabase' | 'speech';
  name: string;
  state: IntegrationState;
  plannedStage: string;
  description: string;
}

/**
 * 외부 연동 상태 — 실제로 작동하지 않는 기능을 작동하는 것처럼 표시하지 않기 위한 단일 출처.
 * 각 연동이 구현되면 해당 항목의 state 계산 로직을 실제 상태 확인으로 교체한다.
 */
export function getIntegrations(proxy: ProxyStatus | null = null): IntegrationInfo[] {
  const remote = integrationConfig.apiBaseUrl != null;
  const youtube: IntegrationInfo = !proxy
    ? { id: 'youtube', name: 'YouTube 영상·재생목록 정보', state: 'not_configured', plannedStage: '2단계', description: '연결 상태 확인 중…' }
    : !proxy.available
      ? {
          id: 'youtube',
          name: 'YouTube 영상·재생목록 정보',
          state: 'not_configured',
          plannedStage: '2단계',
          description: `영상 정보 서버(프록시)에 연결되지 않았습니다${remote ? ' (VITE_API_BASE_URL 확인)' : ''}. 영상은 URL의 ID만으로 등록할 수 있습니다.`,
        }
      : proxy.status.mode === 'api'
        ? { id: 'youtube', name: 'YouTube 영상·재생목록 정보', state: 'connected', plannedStage: '2단계', description: 'YouTube Data API(무료 할당량)로 제목·썸네일·길이와 재생목록 전체를 가져옵니다.' }
        : {
            id: 'youtube',
            name: 'YouTube 영상·재생목록 정보',
            state: 'not_configured',
            plannedStage: '2단계',
            description: 'API 키 없이 제한 모드로 동작 중입니다 (영상: 제목·썸네일만, 재생목록: 최근 15개만).',
          };
  return [
    youtube,
    {
      id: 'transcript',
      name: '유튜브 자막 자동 가져오기',
      state: 'limited',
      plannedStage: '2단계',
      description:
        '공식 API는 영상 소유자만 자막을 내려받을 수 있어, 자막 트랙 존재 여부만 확인하고 내용은 직접 붙여넣습니다. (OAuth 소유자 연동은 미구현)',
    },
    {
      id: 'ai',
      name: 'AI 대화문 생성 · 표현 정리',
      state: 'limited',
      plannedStage: '3·4·7단계',
      description:
        '앱이 유료 AI API를 직접 부르지 않습니다. 핵심 표현 설명·번역은 요청문을 복사해 평소 쓰는 AI 채팅에 붙여넣고 답변을 다시 붙여넣는 방식(추가 비용 없음)으로 받을 수 있어요. 대화문 생성은 4단계에서 같은 방식으로 추가됩니다.',
    },
    {
      id: 'supabase',
      name: 'Supabase 클라우드 동기화',
      state: 'not_implemented',
      plannedStage: '추후',
      description: '현재 모든 데이터는 이 기기의 브라우저(IndexedDB)에만 저장됩니다.',
    },
    {
      id: 'speech',
      name: '음성 인식 · 음성 재생',
      state: 'not_implemented',
      plannedStage: '추후',
      description: '학습은 텍스트 입력 방식으로 진행합니다.',
    },
  ];
}
