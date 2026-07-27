(function () {
  "use strict";

  const POLL_INTERVAL_MS = 750;

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  async function fetchProjectTask(projectId) {
    const response = await fetch(
      "/api/" + projectId + "/task-status",
      {cache: "no-store"}
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "无法读取任务状态");
    }
    return payload;
  }

  async function waitForProjectTask(projectId, taskId, onUpdate) {
    while (true) {
      const payload = await fetchProjectTask(projectId);
      if (
        taskId
        && payload.task
        && payload.task.id
        && payload.task.id !== taskId
      ) {
        throw new Error("项目任务已变化，请刷新页面");
      }
      if (onUpdate) {
        onUpdate(payload);
      }
      if (payload.status !== "running") {
        return payload;
      }
      await new Promise(function (resolve) {
        setTimeout(resolve, POLL_INTERVAL_MS);
      });
    }
  }

  function renderProjectTaskStatus(element, payload) {
    if (!element || !payload) return;

    if (payload.status === "running") {
      const node = escapeHtml(payload.current_node || payload.task.kind);
      element.innerHTML =
        '<p class="muted"><span class="spinner"></span> 当前节点：'
        + node + "</p>";
    } else if (payload.status === "awaiting_approval") {
      element.innerHTML =
        '<p class="alert alert-success">生成完成，图已在 '
        + escapeHtml(payload.pending_gate)
        + " Gate 暂停，等待审批。</p>";
    } else if (payload.status === "failed") {
      const message = payload.last_error && payload.last_error.message
        ? payload.last_error.message
        : "任务执行失败";
      element.innerHTML =
        '<p class="alert alert-error">失败：'
        + escapeHtml(message) + "</p>";
    } else {
      element.innerHTML = "";
    }
  }

  window.fetchProjectTask = fetchProjectTask;
  window.waitForProjectTask = waitForProjectTask;
  window.renderProjectTaskStatus = renderProjectTaskStatus;
})();
