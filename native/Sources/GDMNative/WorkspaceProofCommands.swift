import Foundation

extension WorkspaceStore {
    func toggleProof(compact: Bool) {
        if compact {
            revealPane(.proof)
        } else {
            toggleProof()
        }
    }

    var isFocusedProofPane: Bool {
        if case .proof = workbench.layout.focusedLeaf?.content { return true }
        return false
    }
}
