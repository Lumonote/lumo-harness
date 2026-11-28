/** 必须来自已验证的请求身份；未绑定项目与任意具体项目是不同边界。 */
export interface SessionScope { realm: string; userId: string; projectId?: string | undefined }
export function sameScope(a: SessionScope, b: SessionScope): boolean {
  return a.realm === b.realm && a.userId === b.userId && a.projectId === b.projectId
}
