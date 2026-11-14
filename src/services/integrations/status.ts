import { integrationConfig } from './config';

export type IntegrationState =
  /** 연동 코드와 서버 설정이 모두 준비되어 실제로 작동 */
  | 'connected'
  /** 연동 코드가 아직 구현되지 않음 (해당 개발 단계 예정) */
  | 'not_implemented'
  /** 코드는 있으나 서버 주소/키가 설정되지 않음 */
  | 'not_configured';

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
export function getIntegrations(): IntegrationInfo[] {
  const hasServer = integrationConfig.apiBaseUrl != null;
  return [
    {
      id: 'youtube',
      name: 'YouTube 재생목록 불러오기',
      state: 'not_implemented',
      plannedStage: '2단계',
      description: hasServer
        ? 'API 프록시 주소는 설정되어 있으나 연동 코드가 아직 없습니다.'
        : 'API 키는 서버 프록시를 통해서만 사용합니다. 서버 연동 전에는 영상 정보를 직접 입력합니다.',
    },
    {
      id: 'transcript',
      name: '유튜브 자막 자동 가져오기',
      state: 'not_implemented',
      plannedStage: '2단계',
      description: '자동으로 가져오지 못하면 실패 상태를 표시하고 자막 붙여넣기를 제공합니다.',
    },
    {
      id: 'ai',
      name: 'AI 대화문 생성 · 표현 정리',
      state: 'not_implemented',
      plannedStage: '4·7단계',
      description: 'AI API 연동 전에는 AI 생성 기능을 사용할 수 없습니다.',
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
