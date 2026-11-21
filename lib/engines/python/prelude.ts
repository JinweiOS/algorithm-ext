export const PYTHON_PRELUDE = `from typing import List, Optional, Dict, Set, Tuple

class ListNode:
    val: int
    next: Optional["ListNode"]
    def __init__(self, val: int = 0, next: Optional["ListNode"] = None) -> None: ...

class TreeNode:
    val: int
    left: Optional["TreeNode"]
    right: Optional["TreeNode"]
    def __init__(self, val: int = 0, left: Optional["TreeNode"] = None, right: Optional["TreeNode"] = None) -> None: ...

class Node:
    val: int
    next: Optional["Node"]
    prev: Optional["Node"]
    child: Optional["Node"]
    left: Optional["Node"]
    right: Optional["Node"]
    random: Optional["Node"]
    neighbors: List["Node"]
    children: List["Node"]
    def __init__(self, val: int = 0, next: Optional["Node"] = None) -> None: ...

`;

export const PYTHON_PRELUDE_LINE_COUNT = countLines(PYTHON_PRELUDE) - 1;

const PRELUDE_NAMES = ['ListNode', 'TreeNode', 'Node'] as const;

export function isPreludeRedeclarationDiagnostic(message: string): boolean {
  const normalized = message.toLowerCase();
  if (
    !normalized.includes('obscured by a declaration of the same name') &&
    !normalized.includes('redeclaration')
  ) {
    return false;
  }

  return PRELUDE_NAMES.some((name) => message.includes(name));
}

function countLines(text: string): number {
  return text.split('\n').length;
}
