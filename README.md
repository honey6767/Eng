# My English Study

유튜브 영어 학습 영상의 핵심 문장 5개를 **자연스러운 원어민 대화문**으로 재구성하고,
빈칸을 점점 늘려가며 **대화문 전체를 통째로 암기**하는 개인용 영어 학습 웹앱입니다.

## 실행

```bash
npm install
npm run dev        # 개발 서버 (http://localhost:5173)
npm run build      # 타입 검사 + 프로덕션 빌드
npm test           # 단위 테스트 (Vitest + fake-indexeddb)
npm run e2e        # 빌드 후 실행: 1단계 PC/모바일 E2E 점검 (Playwright)
npm run e2e:stage2 # 빌드 후 실행: 2단계 E2E 점검 (가짜 YouTube 응답 사용)
npm run e2e:stage3 # 빌드 후 실행: 3단계 E2E 점검 (아이패드 화면, 외부 서비스 호출 없음)
```

## YouTube 연동 (2단계) — 무료 구성

```
브라우저 ──/api/youtube/*──▶ 로컬 프록시 (npm run dev / preview 서버 안) ──X-Goog-Api-Key──▶ YouTube Data API v3
          (키를 모름)            (.env.local 의 YOUTUBE_API_KEY 사용)
```

1. `.env.example`을 `.env.local`로 복사하고 `YOUTUBE_API_KEY=`에 키를 넣습니다. (`.env.local`은 Git에 올라가지 않음)
2. `npm run dev`를 다시 실행합니다. 앱의 **설정 → YouTube API 키** 화면에 무료 발급 방법이 자세히 나와 있습니다.

| 모드 | 조건 | 가능한 것 |
|---|---|---|
| API 모드 | `YOUTUBE_API_KEY` 설정 | 재생목록 전체(페이지네이션), 제목·썸네일·길이, 자막 트랙 확인 |
| 제한 모드 | 키 없음 | 개별 영상: 제목·썸네일(oEmbed, 길이 없음) / 재생목록: 최근 15개(RSS) |
| 서버 없음 | 정적 호스팅 등 | 영상 URL의 ID와 공식 썸네일만 저장, 제목 직접 입력 |

- **비용**: YouTube Data API는 무료 할당량(기본 10,000 단위/일)을 넘으면 요청이 거부될 뿐 과금되지 않습니다.
  앱은 자체 상한(`YOUTUBE_DAILY_UNIT_CAP`, 기본 9,000)에서 먼저 호출을 멈추고, Google이 할당량 초과를 알리면 그날은 더 호출하지 않습니다.
  재생목록 100개 영상 ≈ 5단위, 개별 영상 1단위, 자막 확인 50단위.
- **키 보안**: 키는 서버에서만 읽고 Google에 헤더로 전달합니다. `VITE_` 접두사가 없어 브라우저 번들에 포함되지 않습니다(빌드 결과 검사로 확인).
  키 설정에서 **API 제한을 'YouTube Data API v3'만** 허용해 두세요.
- **자막**: 공식 API의 자막 다운로드(`captions.download`)는 OAuth와 영상 소유자/편집 권한이 필요합니다.
  그래서 이 앱은 `captions.list`로 자막 트랙 존재 여부만 확인하고, 내용은 사용자가 붙여넣습니다(SRT·VTT·타임스탬프 텍스트·일반 텍스트). 비공식 우회 방식은 쓰지 않습니다.
- **배포(선택)**: 휴대폰 등에서 인터넷으로 쓰려면 정적 호스팅 + 프록시가 필요합니다. `server/worker.ts`와 `wrangler.toml.example`은
  Cloudflare Workers **무료 플랜**용 템플릿입니다(배포하지 않았음). 배포 후 `VITE_API_BASE_URL`에 Worker 주소를 넣습니다.

## 핵심 문장 · 핵심 표현 (3단계)

- **핵심 문장 5개**: 영상 상세 → **핵심 문장** 탭에서 자막 줄을 눌러 선정합니다. 한 문장이 여러 줄로 나뉘어 있으면 앞·다음 줄을 포함하고,
  필요 없는 앞뒤 말은 단어를 눌러 뺄 수 있습니다(원문 글자는 바꾸지 않음). 자막이 없으면 직접 입력합니다.
- **원문 보호**: 영어 원문은 저장 후 수정할 수 없습니다. 학습·복습 기록이 있거나 대화문에서 쓰인 문장은 선정 취소도 막습니다.
- **핵심 표현 위치**: 문장에서 표현 부분을 저장합니다(5단계 빈칸 위치). `slipped my mind`처럼 형태가 바뀐 표현도 자동으로 찾고,
  못 찾으면 "위치 지정 필요"로 표시해 직접 지정합니다.
- **주요 표현 노트**: 뜻·뉘앙스·사용 상황·예문·비슷한 표현. `영상 설명` / `직접 입력` / `AI 보충(항상 확인 필요)`을 구분합니다.
- **AI 도움(추가 비용 없음)**: 앱은 AI API를 호출하지 않습니다. 요청문을 복사해 평소 쓰는 AI 채팅에 붙여넣고 답변(JSON)을 다시 붙여넣으면,
  검사 후 비어 있는 번역·상황 칸과 AI 보충 노트만 저장합니다.
- **데이터**: 스키마 버전 변경 없음(선택 필드 `expressionSpans`, `origin`만 추가). 기존 학습·복습 기록, 즐겨찾기, 어려움 표시는 건드리지 않습니다.

## 기술 스택

React 19 · TypeScript · Vite · Tailwind CSS v4 · IndexedDB(Dexie) · React Router

## 폴더 구조

```
src/
├─ types/models.ts          도메인 모델 (8단계 전체에 필요한 데이터 구조)
├─ types/youtubeApi.ts      브라우저 ↔ 프록시 응답 형식
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
│  ├─ transcriptParser.ts   자막 파서 (SRT/VTT/타임스탬프 텍스트/일반 텍스트, 형식 자동 감지)
│  ├─ videoImportService.ts 재생목록·개별 영상 등록(영상 ID 기준 중복 방지), 자막 트랙 확인
│  ├─ keySentenceService.ts 핵심 문장 5개 선정(원문 보호·중복 방지·선정 취소 제한), 핵심 표현 연결·위치
│  ├─ expressionNoteService.ts 핵심 표현 노트, 무료 AI 도움(요청문 생성·답변 검사·빈 칸만 채우기)
│  ├─ studyQueue.ts         신규 영상 무작위 학습 순서 (회차·재셔플, IndexedDB 저장)
│  └─ integrations/         외부 연동 설정·상태, youtubeClient(프록시 호출)
server/
├─ youtube/handler.ts       YouTube 프록시 핸들러 (Vite 서버·Cloudflare Worker 공용)
├─ youtube/quota.ts         무료 할당량 추적·자체 상한
├─ youtube/mock.ts          테스트 전용 가짜 응답 (YOUTUBE_API_MOCK=1)
├─ vitePlugin.ts            npm run dev/preview 안에서 /api/youtube/* 처리
└─ worker.ts                (선택) Cloudflare Workers 무료 플랜 배포용
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
| 1 | 기본 구조, 대시보드, 반응형, IndexedDB, 테스트 데이터 | ✅ 완료 (승인됨) |
| 2 | 재생목록·영상 등록, 수동 자막 입력 | ✅ 완료 (승인 대기) |
| 3 | 주요 표현 정리, 핵심 문장 관리 | ✅ 완료 (승인 대기) |
| 4 | 핵심 문장 → 대화문 재구성 (최대 3개) | 예정 |
| 5 | 대화문 5단계 암기 | 예정 |
| 6 | 취약 표현 누적, 복습 일정 | 예정 |
| 7 | 취약 표현 조합 대화문 생성 (AI) | 예정 |
| 8 | 랜덤 테스트, 즐겨찾기 학습, 통계, 백업 | 예정 |
