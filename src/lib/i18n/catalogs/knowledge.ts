// Project Knowledge messages are owned by this bounded feature catalogue.
import { defineCatalog } from "../types";

export const knowledgeCatalog = defineCatalog(
  {
    "knowledge.githubAccessAction": "Choose repositories on GitHub",
    "knowledge.githubAccessHint": "Choose which repositories this workspace can read. GitHub Desktop is not required.",
    "knowledge.githubSignInHint": "Your Personal Workspace stays local. Signing in adds only GitHub repositories owned by that account.",
    "knowledge.githubSignInTitle": "Sign in to connect GitHub",
  },
  {
    "knowledge.githubAccessAction": "GitHub에서 저장소 선택",
    "knowledge.githubAccessHint": "이 워크스페이스가 읽을 저장소를 선택하세요. GitHub Desktop은 설치하지 않아도 됩니다.",
    "knowledge.githubSignInHint": "개인 워크스페이스는 로컬에 유지되고 로그인한 계정의 GitHub 저장소만 연결됩니다.",
    "knowledge.githubSignInTitle": "GitHub 연결을 위해 로그인하세요",
  },
);
