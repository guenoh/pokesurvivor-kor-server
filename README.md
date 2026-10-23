# pokesurvivor-kor-server

`guenoh/pokesurvivor-kor` 전용 독립 Node.js 24/PostgreSQL 백엔드입니다. 원본 Firebase·Google 계정과 데이터를 사용하지 않습니다.

현재 지원: 회원가입(비밀번호 4~128자), 로그인, 세션 확인, 게임 저장/불러오기, 저장 충돌 검사, 로그아웃, 비밀번호 확인 후 계정 삭제, DB 상태 확인, 공지·계정당 1회 서버 보상 지급.

아직 미구현: 비밀번호 복구, OAuth, 친구·협동·랭킹, 클라이언트 게임 데이터의 부정행위 검증. 이 버전의 서버는 게임 상태 보관용이며 서버 권위 전투 서버가 아닙니다.

```sh
pnpm install --frozen-lockfile --ignore-scripts
node --test --test-timeout=30000
export DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/pokesurvivor
node src/migrate.js
APP_ORIGIN=http://localhost:8080 node src/server.js
```

로컬 테스트는 `DATABASE_URL`이 없으면 pg-mem을 사용합니다. GitHub CI와 배포 준비 테스트는 PostgreSQL 17 서비스에서 같은 검사를 실행합니다. 운영은 HTTPS가 필수이며 `NODE_ENV=production`일 때 Secure 쿠키를 사용합니다.

## API

| 경로 | 메서드 | 입력 |
| --- | --- | --- |
| `/api/health` | GET | DB 연결 확인 |
| `/api/auth/register` | POST | `{name,password}` |
| `/api/auth/login` | POST | `{name,password}` |
| `/api/session` | GET | 로그인 세션, 저장, revision |
| `/api/save` | GET | 저장 및 revision |
| `/api/save` | PUT | `{save,revision}` |
| `/api/auth/logout` | POST | 현재 세션 만료 |
| `/api/account` | DELETE | `{password}` |
| `/api/notices` | GET | 공지·계정별 수령 상태 |
| `/api/notices/<id>/claim` | POST | `{revision}` |

변경 요청은 정확한 `APP_ORIGIN`의 Origin 헤더를 요구합니다. 세션 쿠키는 HttpOnly/SameSite=Lax이며 운영에서는 Secure입니다. 토큰 원문 대신 SHA-256 해시를 DB에 저장하고 비밀번호는 salt를 포함한 scrypt 해시로 보관합니다. JSON 요청은 1MiB로 제한합니다. 로그인 제한은 프로세스별/IP별입니다. 프록시가 있다면 신뢰할 수 있는 실제 클라이언트 IP를 기준으로 프록시 자체의 요청 제한도 설정해야 합니다.

`PUT /api/save`는 수정 번호가 일치할 때만 원자적으로 갱신하고 새 번호를 반환합니다. 오래된 수정 번호는 409이며 자동 합치기나 자동 덮어쓰기를 하지 않습니다. 계정 간 저장 데이터는 서로 접근할 수 없습니다. 계정을 지우면 세션과 저장 데이터도 외래 키 cascade로 삭제됩니다.

배포·복구: [DEPLOYMENT.md](DEPLOYMENT.md).

무료 시험 배포는 **[Render + Neon 안내](RENDER-NEON.md)**를 사용합니다. Render의 만료형 무료 DB 대신 Neon Free에 데이터를 보관하며, 게임 서버 재시작과 DB 보관을 분리합니다. 정확한 게임 커밋을 함께 빌드하고 테스트·수동 승인 후 배포하며 암호화 백업을 지원합니다.

공지 문구·오픈 보상과 후원 영역의 설정은 **[공지 운영 안내](NOTICES.md)**를 따릅니다. 수령 기록과 이벤트 시작 시각도 백업에 포함됩니다.

## 권리

이 저장소의 서버 코드는 이번 작업에서 새로 작성한 구현입니다. 게임 코드·그래픽·음악을 포함하지 않으며 원작을 MIT로 재허가하지 않습니다. 서버 자체의 별도 배포 라이선스는 아직 지정하지 않았습니다. 게임과 함께 운영할 때는 원작 코드의 PolyForm Noncommercial 및 그래픽의 비상업·저작자 표시 조건을 준수해야 합니다.
