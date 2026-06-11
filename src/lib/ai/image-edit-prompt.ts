export const CLOSET_DISPLAY_PROMPT_VERSION = "closet-display-v1";

export function buildClosetDisplayPrompt() {
  return `
任务：把参考照片中的单件衣服整理成衣橱 App 可用的白底商品展示图。请把它当作“忠实图像编辑/整理”，不是重新设计衣服。

必须保留：
- 只保留参考图里这件衣服本身，保持同一件衣服的真实身份。
- 严格保留原衣服的主色、材质质感、洗旧/磨白纹理、缝线、领型、肩线、袖长、衣长、下摆形状、门襟、纽扣数量与位置、口袋形状与位置。
- 保留自然布料质感和少量真实褶皱，不要把衣服变成全新的硬挺样衣。

需要处理：
- 移除衣架、夹子、挂钩、床架、柜子、门、墙面、杂物、阴影、环境反光和所有无关背景。
- 将衣服摆正为正面自然垂挂/平铺的电商商品图，完整居中，不裁切领口、袖口、下摆。
- 对拍摄造成的倾斜、遮挡感、随意堆叠感和明显杂乱褶皱做轻度整理，让衣服看起来接近它原本自然展开的样子。
- 如果某些不可见区域需要补全，只能根据参考图的同款结构做保守补全，不能发明新设计。
- 背景为纯白或极浅灰摄影棚背景，柔和真实光线，清晰边缘。

禁止：
- 不要添加模特、人体、手、衣架、吊牌、品牌 logo、文字、水印、价格、额外配饰。
- 不要改变颜色、面料、版型、袖长、衣长、领型、口袋、纽扣、下摆、装饰线或图案。
- 不要把衣服改成更时髦、更修身、更宽松、更厚、更薄或另一个商品。
- 不要过度磨皮、过度熨平、过度美化，不要产生塑料感或假电商图。

输出风格：真实电商平铺/挂拍商品图，front view, centered full garment, white studio background, high fidelity to the reference garment, faithful garment restoration.
`.trim();
}

export function buildClosetDisplayNegativePrompt() {
  return `
model, person, mannequin, human body, hands, hanger, hook, clip, tag, logo, watermark, text, price, extra accessories,
changed color, changed material, changed pocket, changed collar, changed buttons, changed hem, changed sleeve length, changed fit,
new design, different garment, fantasy fashion, over-smoothed fabric, plastic texture, blurry edges, cropped garment, messy background
`.trim();
}
