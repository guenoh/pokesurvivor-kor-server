# 무료 시험 운영: Render + Neon

2026-10-23 공식 안내를 기준으로 Render Free 웹 서비스와 Neon Free PostgreSQL을 사용합니다. **30일 만료형 Render Postgres는 생성하지 않습니다.**

## 데이터 보관 조건

- Neon Free는 기간 제한 없는 무료 플랜입니다. 현재 공식 요금제는 프로젝트당 1GB, 월 100 CU-hours, 외부 전송 5GB를 안내합니다. 실제 계정 콘솔의 한도도 함께 확인하세요.
- Neon의 컴퓨팅/전송 한도 초과는 접속을 일시 정지하고, 저장 공간 한도 초과는 용량을 늘리는 쓰기를 거부합니다. 이런 한도 도달로 데이터를 삭제하지 않는다고 명시합니다. 서비스 변경, 계정 폐쇄, 사고에 대비한 영구 보관 보장은 아니므로 별도 백업이 필요합니다.
- Render Free는 15분 미접속 시 잠들 수 있고 다시 켜질 때 약 1분이 걸릴 수 있습니다. 서버 파일은 재시작하면 사라질 수 있으므로 게임 저장은 Neon에만 기록합니다.
- 두 서비스 모두 무료 플랜을 유지합니다. Render에 결제수단이 있으면 전송량 등 초과 요금이 생길 수 있습니다. 무료 시험 계정에는 결제수단을 추가하지 마세요. 무료 한도 초과로 서비스가 멈추어도 자동 유료 전환은 하지 않습니다.

출처: [Neon 요금](https://neon.com/pricing), [Neon 한도 초과](https://neon.com/docs/introduction/plans), [Render Free](https://render.com/docs/free).

## 구성

`render.yaml`은 무료 웹 서버 하나만 정의합니다. Node.js 24가 API와 빌드된 한국어 게임을 같은 HTTPS 주소에서 제공합니다. `client-release.json`의 정확한 게임 커밋만 빌드하며 게임의 라이선스·크레딧·폰트 라이선스도 포함합니다. 서버 저장소는 독립적으로 유지합니다.

1. Neon Free 프로젝트를 싱가포르, PostgreSQL 17, `pokesurvivor` DB로 만듭니다. 운영용 root branch를 사용하며 만료 시각을 지정하지 않습니다.
2. Render Free 웹 서비스를 서버 저장소 main에 연결합니다. 공개 저장소 연결로 추가 GitHub 접근 권한 없이 배포할 수 있습니다.
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

GitHub `Encrypted database backup`은 매일 04:43 KST에 일관된 읽기 전용 트랜잭션으로 계정·비밀번호 해시·저장 데이터·수정 번호를 읽습니다. 로그인 세션은 제외합니다. RSA-OAEP/SHA-256과 AES-256-GCM으로 암호화한 파일만 Actions artifact에 올립니다. 복구 개인 키는 GitHub/Render에 등록하지 않습니다. 이 백업은 위 표의 배포 승인과 독립적으로 실행됩니다.

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
