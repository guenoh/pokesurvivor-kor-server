# pokesurvivor-kor-server

`guenoh/pokesurvivor-kor` 전용 독립 Node.js 24/PostgreSQL 백엔드입니다. 원본 Firebase·Google 계정과 데이터를 사용하지 않습니다.

현재 지원: 회원가입(비밀번호 4~128자), 로그인, 세션 확인, 게임 저장/불러오기, 저장 충돌 검사, 로그아웃, 비밀번호 확인 후 계정 삭제, DB 상태 확인, 공지·계정당 1회 서버 보상 지급.

친구 요청·수락·삭제, 접속 상태, 초대 전용 최대 4인 협동, 개인·팀 생존 기록을 지원합니다. 아직 미구현: 비밀번호 복구, OAuth, 완전한 부정행위 검증. 이 버전의 서버는 게임 상태 보관용이며 서버 권위 전투 서버가 아닙니다.

```sh
pnpm install --frozen-lockfile --ignore-scripts
node --test --test-timeout=30000
export DATABASE_URL=postgres://USER:PASSWORD@localhost:5432/pokesurvivor
node src/migrate.js
APP_ORIGIN=http://localhost:8080 node src/server.js
```

로컬 테스트는 `DATABASE_URL`이 없으면 기존 계정 검사에 pg-mem, 친구·협동·기록 검사에 PGlite를 사용합니다. GitHub CI와 배포 준비 테스트는 PostgreSQL 17 서비스에서 같은 검사를 실행합니다. 운영은 HTTPS가 필수이며 `NODE_ENV=production`일 때 Secure 쿠키를 사용합니다.

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

## 친구·협동·생존 기록

- 로그인한 계정 이름으로 친구 요청을 보내고 받은 사람이 수락합니다. 이름은 기존 계정 이름을 그대로 사용합니다. 친구 관계·완료 기록·참가 포켓몬은 PostgreSQL에 저장하며 암호화 백업 schema 4에 포함합니다. 이전 schema 1~3 백업도 복원할 수 있습니다.
- `GET /api/community`는 자신의 친구·초대·대기실만 반환합니다. `POST /api/community/friends/request|accept|remove`와 `POST /api/community/room/invite|join|decline|leave|member|start|reopen|drop`는 쿠키 세션과 정확한 Origin 검사를 요구합니다. 초대는 수락한 친구에게만 보내며 3분 후 만료합니다. 대기실 정원은 방장을 포함해 4명입니다.
- `/api/live` WebSocket은 같은 Origin과 세션 쿠키로만 연결합니다. 방장만 시작할 수 있고 참가자·포켓몬·난수 시드는 서버가 정합니다. 전투는 방장 중심으로 전달하며 외부 사용자와 손님 간 직접 전송, 시작 메시지 위조를 차단합니다. 한 계정의 동시 연결은 한 개이며 일시적인 끊김에는 45초의 복귀 유예를 둡니다. 프레임 크기·빈도·버퍼를 제한하며 전투 프레임은 DB에 기록하지 않습니다.
- `POST /api/community/runs/start|finish`로 시작한 도전만 기록합니다. 시작 토큰·실제 경과 시간·중복 제출·고정된 팀 구성을 검사합니다. 게임 전투와 재화는 여전히 클라이언트와 방장이 계산하므로 완전한 치트 방지나 서버 권위 전투를 제공하지 않습니다.
- `GET /api/community/records?mode=s&period=w&friends=1&dex=25`로 오늘·주간·월간·전체 기록을 비교합니다. 일·주·월 경계는 한국 시간이고 주간은 월요일부터입니다. 같은 개인이나 팀의 해당 기간 최고 기록을 표시합니다. 협동의 친구끼리 보기에는 자신이나 친구가 포함된 팀을 표시합니다. 각 표에는 상위 50개와 본인 순위를 제공합니다. 기존 브라우저의 과거 기록은 검증된 공개 순위로 자동 수입하지 않습니다.
- 대기실과 진행 중인 연결은 단일 서버 메모리에 있으므로 서버 재시작 시 종료됩니다. 완료 기록·친구·계정 저장과 기존 오픈 선물 수령 이력은 유지합니다. 다중 서버 운영 전에는 공용 방 상태와 메시지 브로커가 필요합니다. 운영 전송량은 Render 무료 한도에 따릅니다.


### 2026-10-28 원작 호환 업데이트

고정 클라이언트는 원작 `5c97df2e`까지의 변경과 한국판 콘텐츠 분리를 포함합니다. 협동 방을 시작할 때 서버 시간의 Europe/Madrid 할로윈 일정(10월 30일~11월 1일)을 참가자 모두에게 같은 값으로 전달합니다. 기존 JSON 저장에 사탕 장부와 영구 의상을 추가하며, SQL 스키마 변경이나 기존 기록 초기화는 없습니다. 기아 응원 선물과 종료된 오픈 보상 기한은 유지합니다.
