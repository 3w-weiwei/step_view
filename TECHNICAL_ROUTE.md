# 真实 STEP 解析技术路线

## 推荐路线

采用“两层解析架构”：

1. 当前已开始执行的第一层：Node 侧 STEP Part 21 文本解析
2. 后续要补上的第二层：原生 CAD Sidecar（推荐 Open CASCADE / OCCT）

## 第一层：当前已落地

目标：先替换 mock 数据，让产品真的吃到 STEP 文件里的真实信息。

当前输出内容：

- 真实 `PRODUCT` / `PRODUCT_DEFINITION` / `NEXT_ASSEMBLY_USAGE_OCCURRENCE` 装配树
- 真实实例关系与重复件实例
- 真实 `ITEM_DEFINED_TRANSFORMATION` / `AXIS2_PLACEMENT_3D` 变换链
- 真实 BRep 拓扑计数
- 基于真实几何点集计算的零件包围盒
- 基于真实包围盒生成的 viewer 代理几何

当前限制：

- 还没有真实三角网格
- 面级选择和测量仍然基于包围盒代理，不是精确 BRep 面
- 没有精确剖切结果

## 第二层：下一步推荐实现

目标：把“真实结构”推进到“真实几何显示 + 精确交互”。

推荐职责划分：

- Electron / Node：
  - 文件选择、项目管理、缓存目录
  - UI、viewer、交互状态
  - 与 sidecar 的 IPC / CLI 通信
- CAD Sidecar（推荐 C++ + OCCT）：
  - STEP / STEPCAF 读取
  - 装配结构提取
  - BRep 遍历
  - 网格化
  - 精确选择映射
  - 精确测量
  - 剖切计算

推荐输出文件：

```text
project-data/
  {projectId}/
    source.step
    manifest.json
    assembly.json
    mesh.bin
    thumbnail.png
    selection-map.json
```

## 建议的实施顺序

1. 保持现有 Node 文本解析继续作为兜底层
2. 新增 sidecar 协议与任务调度
3. 先接入 OCCT 的装配树 + bbox + 三角网格导出
4. 再补精确选择、测量和剖切

## 当前仓库状态

当前仓库已经进入第 1 步：

- mock 数据开始被真实 STEP 解析替换
- 工作台先消费真实装配结构与真实包围盒
- 现有 viewer 暂时仍以代理几何显示
