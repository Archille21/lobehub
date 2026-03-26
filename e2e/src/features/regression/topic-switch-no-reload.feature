@regression @P0 @agent @topic-switch
Feature: 切换话题不触发页面全量刷新
  作为用户，当我在 Agent 执行过程中切换话题时，页面不应该发生全量重新加载

  Background:
    Given 用户已登录系统
    And 用户进入 Lobe AI 对话页面

  @AGENT-TOPIC-RELOAD-001 @smoke
  Scenario: 在同一 Agent 下切换话题不触发页面刷新
    Given 用户在当前 Agent 中创建了两个对话
    When 用户在页面注入状态标记
    And 用户切换到另一个话题
    Then 页面状态标记应该仍然存在
    And 页面导航类型不应该是全量加载
