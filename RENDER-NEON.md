# Render + Neon 운영

초기 시험 운영은 Render Free 웹 서비스와 Neon Free PostgreSQL로 시작했습니다. 아래 상시 실행 전환은 운영자의 비용 승인을 받은 후 적용합니다. **30일 만료형 Render Postgres는 생성하지 않습니다.**

## 상시 실행 전환 — 2026-11-02 검토

대상은 기존 `pokesurvivor-kor` 웹 서비스 하나입니다. `render.yaml`의 `plan: 0.5c-512mb`는 0.5 CPU·512MB RAM이며, 관리 화면의 기본 요금은 **월 US$7**입니다. 세금·환율·전송량/빌드 등 포함량 초과 비용은 별도일 수 있습니다. Pro 워크스페이스나 추가 인스턴스는 필요하지 않습니다. 운영자의 금액 승인을 받기 전에는 이 설정을 main에 병합하거나 Render에서 Save하지 않습니다.

이 유료 웹 서비스는 트래픽이 없어도 자동 휴면하지 않아, 첫 방문자에게 표시되던 Render 서버 깨우기 화면을 없앱니다. 코드 오류·서비스 장애·배포 중 재연결까지 전혀 없다는 보장은 아닙니다. Neon Free의 자동 일시 중지는 그대로이므로, 오래 쉬었던 DB의 첫 로그인/저장 요청에는 연결 준비 지연이 남을 수 있습니다.

현재 게임 주소·서비스 ID·싱가포르 리전·저장소·클라이언트 고정 커밋·시크릿·Neon DB와 백업 키를 유지합니다. DB 이동이나 초기화, 새 서비스 생성은 하지 않습니다. 변경 절차:

1. Render Compute에서 `Free → 0.5c-512mb (US$7/month)`를 검토하고 운영자의 비용 승인을 받습니다. 결제수단 입력이 필요한 경우 소유자가 직접 처리합니다.
2. 최근 암호화 백업의 실제 backup 작업 성공과 현재 `/release.json`을 확인합니다.
3. 승인한 Compute만 저장합니다. 잠깐 재시작될 수 있으므로 열린 협동 연결은 재연결이 필요할 수 있습니다.
4. 관리 화면에서 변경된 Compute, 공개 `/release.json`과 `/api/health`, 기존 지급 영수증·회원 저장 보존을 확인합니다. 코드가 같으므로 게임 업데이트나 선물 재지급을 유발하지 않습니다.
5. 승인된 설정 변경 PR을 병합해 소스의 `render.yaml`과 실제 서비스 설정을 맞춥니다. 자동 배포 Off와 기존 수동 승인 배포 절차는 유지합니다.

되돌릴 때는 Compute를 Free로 바꾸고 `render.yaml`의 plan도 free로 되돌립니다. 웹 서버만 재시작되며 같은 Neon DB를 계속 사용합니다. Free에서는 15분 미접속 시 휴면 대기가 다시 생깁니다. 이미 사용한 유료 컴퓨팅의 청구분은 별도입니다.

근거: [유료 Compute는 휴면하지 않음](https://render.com/docs/faq), [Compute ID](https://render.com/docs/compute-plans), [Blueprint plan](https://render.com/docs/blueprint-spec#plan). 요금은 해당 서비스의 Render Compute 화면에서 재확인합니다.

## 데이터 보관 조건

- Neon Free는 기간 제한 없는 무료 플랜입니다. 현재 공식 요금제는 프로젝트당 1GB, 월 100 CU-hours, 외부 전송 5GB를 안내합니다. 실제 계정 콘솔의 한도도 함께 확인하세요.
- Neon의 컴퓨팅/전송 한도 초과는 접속을 일시 정지하고, 저장 공간 한도 초과는 용량을 늘리는 쓰기를 거부합니다. 이런 한도 도달로 데이터를 삭제하지 않는다고 명시합니다. 서비스 변경, 계정 폐쇄, 사고에 대비한 영구 보관 보장은 아니므로 별도 백업이 필요합니다.
- 초기 Render Free는 15분 미접속 시 잠들 수 있고 다시 켜질 때 약 1분이 걸릴 수 있습니다. 상시 실행 Compute로 전환하면 이 자동 휴면을 제거합니다. 서버 파일은 재시작하면 사라질 수 있으므로 게임 저장은 Neon에만 기록합니다.
- Neon은 Free를 유지하며 Render Compute만 승인된 유료 요금제로 바꿉니다. 무료 한도 초과를 이유로 DB나 다른 서비스를 자동 유료 전환하지 않습니다. 전송량 등 초과 요금은 계정의 포함량·과금 설정을 따릅니다.

출처: [Neon 요금](https://neon.com/pricing), [Neon 한도 초과](https://neon.com/docs/introduction/plans), [Render Free](https://render.com/docs/free).

## 구성

`render.yaml`은 상시 실행 웹 서버 하나만 정의합니다. Node.js 24가 API와 빌드된 한국어 게임을 같은 HTTPS 주소에서 제공합니다. `client-release.json`의 정확한 게임 커밋만 빌드하며 게임의 라이선스·크레딧·폰트 라이선스도 포함합니다. 서버 저장소는 독립적으로 유지합니다.

1. Neon Free 프로젝트를 싱가포르, PostgreSQL 17, `pokesurvivor` DB로 만듭니다. 운영용 root branch를 사용하며 만료 시각을 지정하지 않습니다.
2. 기존 Render 웹 서비스를 서버 저장소 main에 연결한 상태로 유지합니다. 새로 생성하는 경우 위 유료 Compute 비용을 먼저 승인받아야 합니다. 공개 저장소 연결로 추가 GitHub 접근 권한 없이 배포할 수 있습니다.
3. `render.yaml`의 build/start 명령과 환경변수를 적용합니다. `DATABASE_URL`은 Neon의 TLS 연결 문자열을 비밀 환경변수로 설정합니다. 코드·PR·대화에 노출하지 않습니다. `APP_ORIGIN`이 없으면 Render의 자동 제공 `RENDER_EXTERNAL_URL`을 사용합니다.
4. 건강 확인 경로는 `/healthz`입니다. DB 쿼리를 실행하지 않아 DB가 불필요하게 깨어 있지 않습니다. 실제 DB 연결은 배포 후 `/api/health`로 확인합니다.
5. 최초 생성만 Render 화면에서 배포하고, 이후 자동 배포는 끕니다. 이후에는 GitHub의 `Manual Render deployment`를 main에서 실행합니다. PostgreSQL 테스트와 게임 빌드가 통과한 뒤 production 환경에서 사람이 승인해야 배포 훅을 호출합니다.

production 환경 설정:

| 구분 | 이름 | 내용 |
|---|---|---|
| Secret | `RENDER_DEPLOY_HOOK_URL` | Render가 발급한 이 서비스 전용 배포 훅 |
| Variable | `RENDER_DEPLOY_ENABLED` | 설정 완료 후 `true` |
| Variable | `RENDER_SERVICE_URL` | 실제 `https://….onrender.com` 주소 |

기존 SSH 배포의 `DEPLOY_ENABLED=false`는 유지합니다. Render 자동 배포도 끕니다. upstream 변경은 기존처럼 PR로 들어오며, 병합만으로 서비스가 배포되지는 않습니다. 게임을 갱신할 때 서버 저장소의 `client-release.json`도 테스트한 커밋으로 바꾸고 PR 검사를 통과시킵니다.

## 암호화된 매일 백업

GitHub `Encrypted database backup`은 매일 04:43 KST에 일관된 읽기 전용 트랜잭션으로 계정·비밀번호 해시·저장 데이터·수정 번호·공지 보상 수령 기록·이벤트 시작 시각을 읽습니다. 로그인 세션은 제외합니다. RSA-OAEP/SHA-256과 AES-256-GCM으로 암호화한 파일만 Actions artifact에 올립니다. 복구 개인 키는 GitHub/Render에 등록하지 않습니다. 이 백업은 위 표의 배포 승인과 독립적으로 실행됩니다.

설정은 저장소 수준입니다:

| 구분 | 이름 | 내용 |
|---|---|---|
| Secret | `DATABASE_BACKUP_URL` | Neon DB 연결 문자열 |
| Variable | `BACKUP_PUBLIC_KEY` | 백업용 RSA 공개 키(PEM) |
| Variable | `BACKUP_ENABLED` | 최초 백업 성공 검증 후 `true` |

백업 Secret은 DB 읽기가 필요하며 DB 소유자 접속정보를 쓰는 초기 구성에서는 쓰기 권한도 포함합니다. 더 많은 운영자를 추가하기 전 별도 읽기 전용 계정으로 교체하세요.

복구 키 생성(기존 키를 덮어쓰지 않음):

```sh
node tools/backup.mjs keygen /안전한/개인폴더/recovery.pem
```

`recovery.pem`은 반드시 별도 안전한 위치에도 보관하세요. 이 키가 없으면 암호화된 백업을 복구할 수 없습니다. `.pub` 파일만 GitHub 변수에 넣습니다. 백업은 Actions 실행 페이지에서 내려받습니다. Artifact는 **90일 후 만료**되므로 영구 보관할 파일은 본인 기기 등 별도 장소에도 내려받으세요. DB 자체의 보관 기간과는 별개입니다. GitHub의 예약 작업은 지연되거나 비활성화될 수 있으므로 Actions 실패 알림과 최근 성공 시각을 확인하세요.

복구는 새 빈 PostgreSQL DB에만 허용하며 기존 계정을 덮어쓰지 않습니다:

```sh
export DATABASE_URL='새로 만든 빈 DB의 TLS 연결 문자열'
export BACKUP_PRIVATE_KEY_FILE='/안전한/개인폴더/recovery.pem'
node tools/backup.mjs restore 내려받은파일.pskor-backup
```

PostgreSQL CI에서 원본 계정·저장·수정 번호를 백업→암호화→복호화→새 DB 복구한 결과가 같은지 검사하며, 기존 DB 덮어쓰기 거부와 변조된 암호문 거부도 확인합니다. 복구한 사용자는 다시 로그인해야 합니다.

## 공개 전 확인

`/release.json`의 서버·게임 커밋, `/api/health`, 계정 생성/로그인/저장/다른 브라우저 불러오기, 첫 암호화 백업 성공을 확인합니다. 로컬 계정과 데이터는 별도이며 자동 업로드하지 않습니다. 로그인 제한은 현재 프록시 뒤의 접속 주소 단위로 공유될 수 있으므로 소규모 시험 운영용입니다.

게임 코드의 PolyForm Noncommercial, 그래픽의 CC BY-NC 등 기존 비상업 조건과 포켓몬 IP 권리는 그대로 적용됩니다. 수익화 기능은 이 구성에 포함하지 않습니다.
