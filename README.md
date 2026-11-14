# My English Study

유튜브 영어 학습 영상의 핵심 문장 5개를 **자연스러운 원어민 대화문**으로 재구성하고,
빈칸을 점점 늘려가며 **대화문 전체를 통째로 암기**하는 개인용 영어 학습 웹앱입니다.

## 실행

```bash
npm install
npm run dev        # 개발 서버 (http://localhost:5173)
npm run build      # 타입 검사 + 프로덕션 빌드
npm test           # 단위 테스트 (Vitest + fake-indexeddb)
npm run e2e        # 빌드 후 실행: PC/모바일 브라우저 E2E 점검 (Playwright)
```

## 기술 스택

React 19 · TypeScript · Vite · Tailwind CSS v4 · IndexedDB(Dexie) · React Router

## 폴더 구조

```
src/
├─ types/models.ts          도메인 모델 (8단계 전체에 필요한 데이터 구조)
├─ db/
│  ├─ database.ts           IndexedDB(Dexie) 정의 — 저장소 계층에서만 사용
│  └─ migrations.ts         버전별 스키마/데이터 마이그레이션 (기존 데이터 보존 규칙)
├─ repositories/
│  ├─ types.ts              저장소 인터페이스 (UI·서비스는 여기에만 의존)
│  ├─ indexeddb.ts          IndexedDB 구현
│  └─ index.ts              앱 전역 저장소 (Supabase 이전 시 여기서 교체)
├─ services/
│  ├─ scheduler.ts          에빙하우스 기반 간격 반복 · 복습 우선순위 (순수 함수)
│  ├─ statsService.ts       대시보드 통계 계산
│  ├─ seedService.ts        최초 실행 초기화 · 샘플 데이터
│  ├─ transcriptParser.ts   자막 텍스트 파서 (타임스탬프/SRT/VTT/일반 텍스트)
│  └─ integrations/         외부 연동 설정 · 상태 (YouTube, AI, Supabase — 현재 미연동)
├─ hooks/                   useLiveData(데이터 구독), useConfirm(확인 창), useToast, useAppInit
├─ components/
│  ├─ layout/               AppShell(PC 사이드바 + 모바일 하단 탭), PageHeader
│  ├─ ui/                   Button, Card, Badge, ProgressBar, ConfirmDialog, PlannedNotice …
│  ├─ dialogue/             DialogueView (화자별 말풍선, 핵심 문장 표시)
│  └─ video/                VideoThumb
├─ pages/                   대시보드, 영상, 영상 상세, 대화문, 대화문 상세, 복습, 표현, 즐겨찾기, 설정
├─ data/sampleContent.ts    테스트용 샘플 콘텐츠 (실제 재생목록 내용 아님)
└─ utils/                   날짜, 텍스트 정규화, id, 라벨
```

## 설계 원칙

- **저장소 계층 분리**: UI는 `repos.*` 인터페이스만 사용합니다. Supabase로 옮길 때는 같은 인터페이스를 구현해
  `repositories/index.ts`만 교체합니다. 모든 id는 UUID, 날짜는 ISO 문자열이라 Postgres로 그대로 이전할 수 있습니다.
- **마이그레이션**: 배포된 `db.version(n)`은 수정하지 않고 `version(n+1)`과 `upgrade()`를 추가해 기존 데이터를 변환합니다.
- **비밀정보 보호**: YouTube/AI API 키는 클라이언트에 두지 않습니다. 브라우저는 서버 프록시(`VITE_API_BASE_URL`, 예: Supabase Edge Function)만 호출합니다.
- **가짜 기능 금지**: 구현되지 않은 기능은 `PlannedNotice` / `PlannedButton`(비활성 + "n단계 예정")으로 표시합니다.
  연동 상태는 `services/integrations/status.ts` 한 곳에서 관리합니다.
- **샘플 데이터 분리**: 샘플은 모두 `isSample=true`이며, 설정에서 사용자 데이터를 건드리지 않고 삭제할 수 있습니다.
- **위험한 작업 확인**: 샘플 삭제는 확인 창, 전체 초기화는 확인 문구("초기화") 입력이 필요합니다.

## 개발 단계

| 단계 | 내용 | 상태 |
|---|---|---|
| 1 | 기본 구조, 대시보드, 반응형, IndexedDB, 테스트 데이터 | ✅ 완료 (승인 대기) |
| 2 | 재생목록·영상 등록, 수동 자막 입력 | 예정 |
| 3 | 주요 표현 정리, 핵심 문장 관리 | 예정 |
| 4 | 핵심 문장 → 대화문 재구성 (최대 3개) | 예정 |
| 5 | 대화문 5단계 암기 | 예정 |
| 6 | 취약 표현 누적, 복습 일정 | 예정 |
| 7 | 취약 표현 조합 대화문 생성 (AI) | 예정 |
| 8 | 랜덤 테스트, 즐겨찾기 학습, 통계, 백업 | 예정 |
