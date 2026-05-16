# 약품 공유 게시판 v2 · 로컬약국 네트워크 · 프로젝트 기억장치

> 세션 시작 시 이 파일을 먼저 읽어주세요.

---

## 프로젝트 개요
- **로컬약국 네트워크** — 약사들이 약품 정보를 위키처럼 공동으로 만들어가는 게시판
- **스택**: GitHub Pages(정적 호스팅) + Supabase(DB·인증·스토리지)
- 키오스크 프로젝트(`로컬약국의 창고화 시스템`)와 별도 운영, 추후 연동 예정

---

## 핵심 철학 (v2에서 바뀐 것)
- **위키형 버전 관리**: 한 약품에 여러 사람이 각자 버전을 올림
- **다운로드 수 = 인기순**: 가장 많이 가져간 버전이 자동으로 대표 버전
- **가격 없음**: 각 약국이 키오스크에서 직접 설정
- **이미지 방식**: 제약사 공식 사이트 이미지 URL 링크 or 직접 업로드
- **분류**: 1차=제약사별, 2차=기능태그 (두 가지 동시 필터)

---

## 핵심 파일

| 파일 | 역할 |
|------|------|
| `index.html` | 게시판 SPA v2 (936줄, 버전 시스템 전면 재작성) |
| `supabase_setup.sql` | v2 스키마 SQL (manufacturers + drugs + drug_versions) |

---

## 인프라 정보

### Supabase
- **프로젝트명**: pharmacy-board
- **URL**: `https://cnpaelquawzpywtdpmkw.supabase.co`
- **anon key**: index.html 상단에 하드코딩됨

### DB 테이블 구조 (v2)
| 테이블 | 역할 |
|--------|------|
| `profiles` | 사용자 프로필 (약국명) |
| `manufacturers` | 제약사 마스터 (초기 9개 삽입됨) |
| `drugs` | 약품 마스터 (이름·제약사·카테고리·태그) |
| `drug_versions` | 버전별 콘텐츠 (이미지URL×3·효능·용법·약사한마디·다운로드수) |

### Supabase 트리거
- `on_auth_user_created` → 회원가입 시 profiles 자동 생성
- `on_version_change` → 버전 등록/삭제 시 drugs 집계(version_count, total_downloads, best_version_id) 자동 갱신

### RPC 함수
- `increment_version_downloads(p_version_id)` → 다운로드 카운트 안전 증가

---

## 식약처 공공 API (발급 완료)
| 서비스명 | 용도 |
|----------|------|
| 식품의약품안전처_의약품개요정보(e약은요) | 효능·용법 텍스트 (소비자 눈높이) |
| 식품의약품안전처_의약품 제품 허가정보 | 제약사명, 성분, 허가 정보 |
| 식품의약품안전처_의약품 낱알식별 정보 | 낱알 이미지 (박스 사진은 아님) |
| 식품의약품안전처_건강기능식품정보 | 비타민·영양제 카테고리용 |
| 식품의약품안전처_의약품안전사용서비스(DUR)품목정보 | 향후 상호작용 기능용 |
| 식품의약품안전처_의약품안전사용서비스(DUR)성분정보 | 향후 성분 기반 검색용 |

---

## 이미지 전략
- **박스 사진**: 약사가 직접 찍어 업로드 OR 제약사 공식 제품 페이지 이미지 URL 링크
- **낱알 사진 API**: 키오스크에서 낱알을 보여주지 않으므로 활용 안 함
- **스토리지 버킷**: `drug-images` (직접 업로드 시 사용)

---

## 연관 프로젝트 (키오스크)
| 항목 | 값 |
|------|-----|
| 키오스크 URL | `https://real0741-web.github.io/local-pharmacy/` |
| Worker 프록시 | `https://pharmacy-proxy.speed0324.workers.dev` |

### 키오스크 내보내기 포맷 (v2)
```json
{
  "source": "약품공유게시판",
  "version": 2,
  "drug": {
    "name": "약품명",
    "emoji": "💊",
    "cat": "카테고리",
    "tagline": "효능 요약 (60자)",
    "info": "용법·용량",
    "pharmacistNote": "약사 한마디",
    "imageUrl": "이미지URL",
    "price": 0,
    "list": 0
  }
}
```

---

## 작업 규칙
1. **수정 전 → 백업** (`이전버전들/날짜_시간/` 폴더)
2. **Supabase RLS** — 모든 테이블 Row Level Security 적용
3. **GitHub 배포** — 직접 push 필요

---

## ⚠️ Supabase 적용 필요 (아직 안 한 것)
```
기존 테이블 DROP 후 v2 SQL 실행:
1. Supabase SQL Editor 열기
2. 아래 먼저 실행:
   drop table if exists drug_likes, drug_versions, drugs, manufacturers, profiles cascade;
3. supabase_setup.sql 전체 붙여넣고 Run
```

---

## 관리자 모드
- URL: `?mode=admin` 으로 접근
- 로그인 + 관리자 모드 → `+ 약품 등록`, `🤖 AI 등록` 버튼 표시
- 일반 로그인 → 버전 업로드만 가능

## AI 빠른 등록 (v2.1 추가)
- **게시판 전용 Worker**: `board_worker.js` → Cloudflare에 별도 배포
  - 키오스크 Worker(`pharmacy-proxy`)와 완전히 독립
  - 배포 후 URL을 `index.html` 의 `WORKER_URL` 상수에 입력
- Worker 액션:
  - `analyzeDrugBoard`: 약품명 → AI가 효능/용법/약사한마디 생성
  - `scrapePharmaSite`: 제약사 제품 페이지 URL → HTML 파싱 + AI 추출
- 프론트 함수: `openAIRegisterModal()`, `switchAITab()`, `runAIAnalysis()`, `submitAIRegister()`
- AI 등록 모달: 탭 방식 (약품명 입력 / 페이지 URL 스크래핑)

---

## AI 등록 모달 (v2.2 업데이트)
- **탭 3개**: 약품명 / URL 스크래핑 / 📋 일괄
- **일괄 탭**: 약품명 여러 줄 입력 → AI 순차 분석 → 자동 등록 + 실시간 로그
  - 형식: `약품명` 또는 `약품명|제약사명`
  - API 레이트리밋 방지: 항목 간 0.8초 대기
- **계속 등록 버튼**: Step 2에서 등록 후 모달 유지, Step 1 초기화
- **Step 2 이미지 미리보기**: 스크래핑된 이미지 확인 가능
- **_source 배지 수정**: 식약처/스크래핑/AI+네이버/AI 정상 표시

---

## 진행 상황
- [x] v1 UI 완성 및 백업
- [x] v2 설계 확정 (위키형 버전 관리, 제약사별 분류)
- [x] v2 DB 스키마 SQL 작성
- [x] v2 index.html 완성
- [x] 관리자 모드 (`?mode=admin`) 구현
- [x] AI 빠른 등록 모달 (약품명 / URL / 일괄 탭) 완성
- [x] Cloudflare Worker (`pharmacy-board`) 배포 완료 — URL: `https://pharmacy-board.speed0324.workers.dev`
- [x] 5개 환경변수 등록 (CLAUDE, GROQ, MFDS, NAVER_ID, NAVER_SECRET)
- [ ] **Supabase에 v2 SQL 실행** (아직 미실행 시)
- [ ] GitHub 저장소 배포
- [ ] 키오스크 "게시판에서 붙여넣기" 버튼 추가

---

## 다음에 할 것
1. Supabase SQL Editor에서 supabase_setup.sql 실행 (미실행 시)
2. GitHub Pages 배포 (`약품공유게시판/index.html`)
3. 일괄 등록으로 초기 약품 DB 구성
4. 키오스크 연동 버튼 추가
