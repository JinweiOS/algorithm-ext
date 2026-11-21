export const CPP_PRELUDE = `#include <vector>
#include <string>
#include <algorithm>
#include <unordered_map>
#include <map>
#include <set>
#include <unordered_set>
#include <queue>
#include <stack>
#include <deque>
#include <cmath>
#include <climits>
#include <cstring>
#include <numeric>
#include <functional>
#include <utility>
#include <tuple>
#include <bitset>
#include <array>
#include <limits>
#include <memory>

using namespace std;

struct ListNode {
    int val;
    ListNode *next;
    ListNode() : val(0), next(nullptr) {}
    ListNode(int x) : val(x), next(nullptr) {}
    ListNode(int x, ListNode *next) : val(x), next(next) {}
};

struct TreeNode {
    int val;
    TreeNode *left;
    TreeNode *right;
    TreeNode() : val(0), left(nullptr), right(nullptr) {}
    TreeNode(int x) : val(x), left(nullptr), right(nullptr) {}
    TreeNode(int x, TreeNode *left, TreeNode *right)
        : val(x), left(left), right(right) {}
};

class Node {
public:
    int val;
    Node *next;
    Node *prev;
    Node *child;
    Node *left;
    Node *right;
    Node *random;
    vector<Node *> neighbors;
    vector<Node *> children;
    Node() : val(0), next(nullptr), prev(nullptr), child(nullptr),
        left(nullptr), right(nullptr), random(nullptr) {}
    Node(int value) : Node() { val = value; }
    Node(int value, vector<Node *> adjacent) : Node(value) {
        neighbors = std::move(adjacent);
    }
};

`;

export const CPP_PRELUDE_LINE_COUNT = CPP_PRELUDE.split('\n').length - 1;

const PRELUDE_NAMES = ['ListNode', 'TreeNode', 'Node'] as const;

export function isCppPreludeDiagnostic(message: string): boolean {
  const normalized = message.toLowerCase();
  const isRedeclaration =
    normalized.includes('redefinition') ||
    normalized.includes('redeclaration') ||
    normalized.includes('already defined');
  return (
    isRedeclaration && PRELUDE_NAMES.some((name) => message.includes(name))
  );
}
