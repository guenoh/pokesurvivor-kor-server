# 배포 준비 및 운영 가이드

현재 운영 서버·도메인은 미정입니다. 두 GitHub 저장소의 `production` 환경은 수동 승인을 요구하고 `DEPLOY_ENABLED=false`로 설정합니다. 실제 배포는 실행하지 않습니다.

## 서버 준비

1. 도메인과 Linux 서버를 준비하고 Docker Engine/Compose v2, nginx, rsync, SSH를 설치합니다. HTTPS 인증서를 설치합니다.
2. 전용 배포 계정으로 `/srv/pokesurvivor-kor/releases`, `/srv/pokesurvivor-kor-server/releases`, `/srv/pokesurvivor-kor-server/backups`를 만듭니다. 비밀번호 없는 관리자 전체 권한 대신 필요한 디렉터리·Docker 접근 권한만 부여합니다.
3. `.env.example`을 참고해 서버의 `/srv/pokesurvivor-kor-server/.env`를 직접 만듭니다. 파일 권한은 600으로 설정합니다. DB 비밀번호는 URL 인코딩 문제가 없는 긴 무작위 16진수로 생성합니다. `APP_ORIGIN`은 정확한 HTTPS 출처이며 끝에 `/`를 붙이지 않습니다.
4. `nginx.example.conf`의 location들을 HTTPS 서버 블록에 적용합니다. 프런트엔드와 `/api`는 반드시 같은 출처로 제공합니다. DB 포트는 외부에 공개하지 않습니다. API는 호스트의 127.0.0.1:3000만 사용합니다.
5. 서버 저장소를 복제한 뒤 `docker compose --env-file /srv/pokesurvivor-kor-server/.env up -d --wait postgres`, `docker compose --env-file ... build api`, `docker compose --env-file ... run --rm api node src/migrate.js`, `docker compose --env-file ... up -d api`로 초기화할 수도 있습니다.

## GitHub 환경 설정

두 저장소의 Settings → Environments → production에 다음 값을 설정합니다.

| 종류 | 이름 | 값 |
| --- | --- | --- |
| 변수 | `DEPLOY_HOST` | SSH 서버 호스트명 또는 IPv4 |
| 변수 | `DEPLOY_USER` | 배포 계정 |
| 비밀 | `DEPLOY_SSH_KEY` | 전용 SSH 개인 키 |
| 비밀 | `DEPLOY_KNOWN_HOSTS` | 별도 경로로 지문을 검증한 SSH 호스트 키 |
| 변수 | `DEPLOY_ENABLED` | 서버 준비가 끝나기 전 `false`, 검증 후 `true` |

필수 검토자는 `guenoh`이며 `main` 브랜치만 배포합니다. 관리자 보호 규칙 우회는 끕니다. 단독 운영 계정이 수동 실행 후 승인할 수 있도록 자기 승인 금지는 사용하지 않습니다. 환경 보호 규칙은 YAML만으로 설정되지 않으므로 GitHub 설정에서 실제 구성을 확인해야 합니다.

`Manual production deployment`를 `main`에서 수동 실행합니다. 테스트/빌드가 실패하면 승인 단계에 도달하지 않습니다. 서버 저장소의 준비 단계는 PostgreSQL 17로 테스트합니다. 승인 후 서버 소스를 새 릴리스 디렉터리에 올리고 DB 백업 → 이미지 빌드 → 마이그레이션 → API 재시작 → health 확인을 수행합니다. 프런트엔드는 정적 배포물을 새 디렉터리에 올리고 `current` 심볼릭 링크를 교체합니다.

## 확인

- `/api/health`가 `{ok:true}`를 반환하는지 확인합니다.
- 실제 도메인에서 새 계정 생성 → 파트너 선택 → 플레이 → 저장 → 다른 브라우저 로그인·불러오기를 확인합니다.
- 두 브라우저에서 같은 계정으로 저장해 409 충돌과 백업 내보내기를 확인합니다.
- 계정 삭제·세션 만료·DB 재시작 후 저장 지속성을 확인합니다.
- 운영자 연락처, 데이터 보존/삭제, 백업 보존 정책을 실제 운영 조건에 맞게 확정합니다.

## 백업과 복구

배포 시 `/srv/pokesurvivor-kor-server/backups/<commit>.sql`에 DB 백업을 만듭니다. 이 파일에는 사용자 데이터가 있으므로 접근을 제한하고, 별도의 암호화된 외부 백업과 보존·삭제 주기를 운영 전에 설정합니다. 소스 코드 Git 저장소에는 백업을 올리지 않습니다. 이 작업에는 예약 DB 백업이 포함되지 않았습니다.

프런트엔드는 `current`를 이전 릴리스 디렉터리로 원자적으로 바꾸면 됩니다. API는 이전 릴리스의 compose 파일과 `RELEASE_TAG=<이전 커밋>`으로 이미지를 실행합니다. 이미지가 없으면 해당 릴리스 소스로 다시 빌드합니다. 배포 health 검사 실패 시 워크플로는 실패하며 API를 자동으로 이전 버전으로 돌리지 않습니다. 운영자가 로그와 DB 스키마 호환성을 확인한 후 복구합니다.

초기 마이그레이션은 테이블 생성만 수행합니다. 향후 스키마 변경은 번호별 마이그레이션과 하위 호환성 검토가 필요합니다. DB 복원은 현재 데이터를 덮어쓸 수 있으므로 운영 중 자동 실행하지 않습니다. 먼저 별도 데이터베이스에서 백업 복구를 검증하세요.
